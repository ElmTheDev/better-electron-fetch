/**
 * index.js
 *
 * a request API compatible with window.fetch
 */

// eslint-disable-next-line node/no-deprecated-api
const urlModule = require('url');
const resolveURL = urlModule.resolve;

const http = require('http');
const https = require('https');
const zlib = require('zlib');

const fetch = require('node-fetch');
const ToughCookie = require('tough-cookie');

const {
    PassThrough
} = require('stream');

const {
    writeToStream
} = require('./body');

const Response = require('./response');
const Headers = require('./headers').Headers;
const {
    Request
} = require('./request');
const {
    getNodeRequestOptions
} = require('./request');

const FetchError = require('./fetch-error');

let electron
// istanbul ignore else
if (process.versions.electron) {
    electron = require('electron')
}



function parseProxy(proxy) {
    proxy = proxy.replace('http://', '');
    var ip, port, username, password;
    if (proxy.includes('@'))
        [username, password, ip, port] = proxy.replace('@', ':').split(":")
    else
        [ip, port] = proxy.split(":");

    /* if (!ip || !port || ip.startsWith("127.") || ip === "localhost") // Local proxy/Malformed
      return {
        url: "",
        requiresAuth: false
      }
  */

    if (ip && port && (!username || !password))
        return {
            url: `${ip}:${port}`,
            requiresAuth: false
        }
    else
        return {
            url: `${ip}:${port}`,
            username,
            password,
            requiresAuth: true
        }
}

async function handleSetCookie(request, options, response) {
    const setCookieHeader = response.headers.get('set-cookie');
    if (options.jar && setCookieHeader) {
        var parsedCookies;
        if (setCookieHeader instanceof Array) {
            try {
                parsedCookies = setCookieHeader.map(ToughCookie.Cookie.parse);
            } catch (e) {
                //console.log(1)
            }
        } else {
            try {
                parsedCookies = [ToughCookie.Cookie.parse(setCookieHeader)];
            } catch (e) {
                //console.log(2)
            }
        }
        for (var cookie of parsedCookies) {
            var urlOrigin = new URL(request.url).origin;
            if (urlOrigin.includes(cookie.cdomain()) || !cookie.cdomain()) {
                await options.jar.setCookie(`${cookie.key}=${cookie.value}`, urlOrigin);
                await options.jar.setCookie(
                    `${cookie.key}=${cookie.value}`,
                    urlOrigin.replace('www.', '')
                );
            }
        }
    }
}

const requestFunction = function (url, opts = {}) {
    // wrap http.request into fetch
    return electron.app.whenReady().then(() => new Promise(async (resolve, reject) => {
        // build request object
        const request = new Request(url, opts)
        const options = getNodeRequestOptions(request)

        const send = request.useElectronNet ?
            electron.net.request :
            (options.protocol === 'https:' ? https : http).request

        // http.request only support string as host header, this hack make custom host header possible
        if (options.headers.host) {
            options.headers.host = options.headers.host[0]
        }

        if (request.signal && request.signal.aborted) {
            reject(new FetchError('request aborted', 'abort'))
            return
        }

        let proxy;
        if (options.proxy) {
            proxy = parseProxy(options.proxy);
        }
        // send request
        let headers
        if (request.useElectronNet) {
            headers = options.headers
            delete options.headers
            options.session = opts.session || electron.session.defaultSession
            options.useSessionCookies = request.useSessionCookies
            options.followRedirect = options.followAllRedirects ? 'follow' : 'manual';
            options.redirect = options.followAllRedirects ? 'follow' : 'manual';

            if (options.proxy) { // Proxying HTTP request
                await options.session.setProxy({
                    proxyRules: proxy.url
                });
            }
        } else {
            if (opts.agent) options.agent = opts.agent
        }
        const req = send(options)

        if (request.useElectronNet) {

            for (const headerName in headers) {
                if (typeof headers[headerName] === 'string') req.setHeader(headerName, headers[headerName])
                else {
                    for (const headerValue of headers[headerName]) {
                        req.setHeader(headerName, headerValue)
                    }
                }
            }
        }
        let reqTimeout

        const abortRequest = () => {
            const err = new FetchError('request aborted', 'abort')
            reject(err)
            if (request.useElectronNet) {
                req.abort()
            } else {
                req.destroy(err)
            }
        }

        if (request.signal) {
            request.signal.addEventListener('abort', abortRequest)
        }

        if (request.timeout) {
            reqTimeout = setTimeout(() => {
                const err = new FetchError(`network timeout at: ${request.url}`, 'request-timeout')
                reject(err)
                if (request.useElectronNet) {
                    req.abort()
                } else {
                    req.destroy(err)
                }
            }, request.timeout)
        }

        if (request.useElectronNet) {
            if (options.proxy && proxy.username && proxy.password) {
                opts.user = proxy.username;
                opts.password = proxy.password;
            }
            // handle authenticating proxies
            req.on('login', (authInfo, callback) => {
                if (opts.user && opts.password) {
                    callback(opts.user, opts.password)
                } else {
                    req.abort()
                    reject(new FetchError(`login event received from ${authInfo.host} but no credentials provided`, 'proxy', {
                        code: 'PROXY_AUTH_FAILED'
                    }))
                }
            })
        }

        req.on('error', err => {
            clearTimeout(reqTimeout)
            if (request.signal) {
                request.signal.removeEventListener('abort', abortRequest)
            }

            reject(new FetchError(`request to ${request.url} failed, reason: ${err.message}`, 'system', err))
        })

        req.on('abort', () => {
            clearTimeout(reqTimeout)
            if (request.signal) {
                request.signal.removeEventListener('abort', abortRequest)
            }
        })

        function handleRequest(res, isRedirect = false) {
            clearTimeout(reqTimeout)
            if (request.signal) {
                request.signal.removeEventListener('abort', abortRequest)
            }

            // handle redirect
            if (fetch.isRedirect(res.statusCode) && request.redirect !== 'manual') {
                if (request.redirect === 'error') {
                    reject(new FetchError(`redirect mode is set to error: ${request.url}`, 'no-redirect'))
                    return
                }

                if (request.counter >= request.follow) {
                    reject(new FetchError(`maximum redirect reached at: ${request.url}`, 'max-redirect'))
                    return
                }

                if (!res.headers.location) {
                    reject(new FetchError(`redirect location header missing at: ${request.url}`, 'invalid-redirect'))
                    return
                }

                // per fetch spec, for POST request with 301/302 response, or any request with 303 response, use GET when following redirect
                if (res.statusCode === 303 ||
                    ((res.statusCode === 301 || res.statusCode === 302) && request.method === 'POST')) {
                    request.method = 'GET'
                    request.body = null
                    request.headers.delete('content-length')
                }

                request.counter++

                const headers = new Headers()
                for (const name of Object.keys(res.headers)) {
                    if (Array.isArray(res.headers[name])) {
                        for (const val of res.headers[name]) {
                            headers.append(name, val)
                        }
                    } else {
                        headers.append(name, res.headers[name])
                    }
                }
                res.headers = headers;

                if(options.followAllRedirects)
                    resolve(fetch(resolveURL(request.url, res.headers.location), request))
                else
                    resolve(res)
                return
            }

            // normalize location header for manual redirect mode
            const headers = new Headers()
            for (const name of Object.keys(res.headers)) {
                if (Array.isArray(res.headers[name])) {
                    for (const val of res.headers[name]) {
                        headers.append(name, val)
                    }
                } else {
                    headers.append(name, res.headers[name])
                }
            }
            if (request.redirect === 'manual' && headers.has('location')) {
                headers.set('location', resolveURL(request.url, headers.get('location')))
            }

            // prepare response
            let body = new PassThrough()
            if (!isRedirect) {
                res.on('error', err => body.emit('error', err))
                res.pipe(body)
            }

            const abortBody = () => {
                res.destroy()
                res.emit('error', new FetchError('request aborted', 'abort')) // separated from the `.destroy()` because somehow Node's IncomingMessage streams do not emit errors on destroy
            }

            if (request.signal && !isRedirect) {
                request.signal.addEventListener('abort', abortBody)
                res.on('end', () => {
                    request.signal.removeEventListener('abort', abortBody)
                })
                res.on('error', () => {
                    request.signal.removeEventListener('abort', abortBody)
                })
            }

            const responseOptions = {
                url: request.url,
                status: res.statusCode,
                statusText: res.statusMessage,
                headers: headers,
                size: request.size,
                timeout: request.timeout,
                useElectronNet: request.useElectronNet,
                useSessionCookies: request.useSessionCookies
            }

            // HTTP-network fetch step 16.1.2
            const codings = headers.get('Content-Encoding')

            // HTTP-network fetch step 16.1.3: handle content codings

            // in following scenarios we ignore compression support
            // 1. running on Electron/net module (it manages it for us)
            // 2. HEAD request
            // 3. no Content-Encoding header
            // 4. no content response (204)
            // 5. content not modified response (304)
            if (!request.useElectronNet && request.method !== 'HEAD' && codings !== null &&
                res.statusCode !== 204 && res.statusCode !== 304) {
                // Be less strict when decoding compressed responses, since sometimes
                // servers send slightly invalid responses that are still accepted
                // by common browsers.
                // Always using Z_SYNC_FLUSH is what cURL does.
                // /!\ This is disabled for now, because it seems broken in recent node
                // const zlibOptions = {
                //   flush: zlib.Z_SYNC_FLUSH,
                //   finishFlush: zlib.Z_SYNC_FLUSH
                // }

                if (codings === 'gzip' || codings === 'x-gzip') { // for gzip
                    body = body.pipe(zlib.createGunzip())
                } else if (codings === 'deflate' || codings === 'x-deflate') { // for deflate
                    // handle the infamous raw deflate response from old servers
                    // a hack for old IIS and Apache servers
                    const raw = res.pipe(new PassThrough())
                    return raw.once('data', chunk => {
                        // see http://stackoverflow.com/questions/37519828
                        if ((chunk[0] & 0x0F) === 0x08) {
                            body = body.pipe(zlib.createInflate())
                        } else {
                            body = body.pipe(zlib.createInflateRaw())
                        }
                        const response = new Response(body, responseOptions);
                        handleSetCookie(request, options, response);
                        resolve(response)
                    })
                }
            }

            const response = new Response(body, responseOptions)
            handleSetCookie(request, options, response);
            resolve(response)
        }

        req.on('response', handleRequest);
        req.on('redirect', (statusCode, method, redirect, responseHeader) => {
            handleRequest({
                finalURL: redirect,
                statusCode,
                status: statusCode,
                headers: responseHeader,
                text: () => '',
                json: () => {}
            }, true)
        });

        writeToStream(req, request)
    }))
};

requestFunction.jar = () => {
    return new ToughCookie.CookieJar();
}

module.exports = requestFunction;