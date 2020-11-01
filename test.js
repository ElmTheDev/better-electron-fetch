const Request = require('./lib/index');

(async () => {
    const sess = Request.jar()
    const response = await Request('http://rattenfanger.io', {
            method: 'POST',
            body: 'hello=true',
            headers: {
                'user-agent': 'better electron fetch'
            },
            jar: sess,
            proxy: 'http://127.0.0.1:8888',
            followAllRedirects: false,
        });

        console.log(response)
        //console.log(await response.json())
})();