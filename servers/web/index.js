var FormData = require('form-data');
const http = require('node:http');
const express = require('express');
const app = express();

app.use(express.static('public'));

app.get('/access-token/:code', (req, res)=>{
    const auth_code = req.params.code;
    if(!auth_code) res.send(400);

    // const form = new FormData();
    // form.append('client_id', 'python_pvp');
    // form.append('client_secret', 'KzDuemA9u3Tacf9OlWXIul7BpBC2rZW2');
    // form.append('grant_type', 'authorization_code');
    // form.append('redirect_uri','http://localhost:2000/auth-redirect');
    // form.append('code', auth_code);

    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'python_pvp',
        client_secret: 'PthnyrQvoITMiyy3R6rClhEUUDF7WdEA',
        code: auth_code,
        redirect_uri: 'http://localhost:2000/get-code',
    });
    const postData = params.toString();

    const request = http.request({
        hostname: '127.0.0.1',
        port: 8080,
        path: `/realms/python_pvp/protocol/openid-connect/token`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        }
    }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
            // console.log('Response:', data);  // Contains access_token and id_token in JSON
            const jsondata = JSON.parse(data);
            if(data.error){
                res.status(400).json(jsondata);
            }else{
                res.status(200).json(jsondata);
            }
        });
    });
    
    request.on('error', (err)=>{
        console.log(err);
        res.send(200);
    })

    request.write(postData);
    request.end();
});

app.listen(2000, '127.0.0.1', ()=>{
    console.log('listening on 80');
});

