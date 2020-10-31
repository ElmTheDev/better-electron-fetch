/**
 * response.js
 *
 * Response class provides content decoding
 */

const {
    STATUS_CODES
} = require('http');
const Headers = require('./headers').Headers;
const Body = require('./body').Body;
const {
    clone,
} = require('./body');


/**
 * Response class
 *
 * @param {Stream} body Readable stream
 * @param {Object} opts Response options
 */
class Response {
    constructor(body = null, opts = {}) {
        Body.call(this, body, opts)

        this.url = opts.url
        this.status = opts.status || 200
        this.statusText = opts.statusText || STATUS_CODES[this.status]
        this.headers = new Headers(opts.headers)
        this.useElectronNet = opts.useElectronNet

        Object.defineProperty(this, Symbol.toStringTag, {
            value: 'Response',
            writable: false,
            enumerable: false,
            configurable: true
        })
    }

    /**
     * Convenience property representing if the request ended normally
     */
    get ok() {
        return this.status >= 200 && this.status < 300
    }

    /**
     * Clone this response
     *
     * @return {Response}
     */
    clone() {
        return new Response(clone(this), {
            url: this.url,
            status: this.status,
            statusText: this.statusText,
            headers: this.headers,
            ok: this.ok,
            useElectronNet: this.useElectronNet
        })
    }
}

module.exports = Response;

Body.mixIn(Response.prototype)

Object.defineProperty(Response.prototype, Symbol.toStringTag, {
    value: 'ResponsePrototype',
    writable: false,
    enumerable: false,
    configurable: true
})