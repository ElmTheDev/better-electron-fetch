const Request = require('./lib/index');

(async () => {
    const response = await Request('http://httpbin.org/post', {
            method: 'POST',
            body: 'hello=true',
            headers: {
                'user-agent': 'better electron fetch'
            },
            timeout: 1
        });
        console.log(await response.json())
})();