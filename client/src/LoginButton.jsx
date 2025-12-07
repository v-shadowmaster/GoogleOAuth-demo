// client/src/LoginButton.js
import React from 'react';
import { Button } from './components/pill-shaped-button';

function LoginButton() {
    const handleLogin = () => {
        const params = {
            client_id: "",
            redirect_uri: "",
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'offline',
            prompt: 'consent'
        };
        const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(params);
        window.location.href = url;
    };

    return (
        <div className='flex justify-center items-center min-h-screen'>
            <Button className='max-w-screen-xl' variant="secondary" onClick={handleLogin}>
                <img src="/google.svg" alt="Google" className="w-5 h-5" />
                Continue with Google
            </Button>
        </div>
    );
}

export default LoginButton;
