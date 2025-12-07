import React, { useEffect, useContext } from 'react';
import { useNavigate } from "react-router-dom";
import { AuthContext } from './AuthContext';

function OAuth2RedirectHandler() {
    const { login } = useContext(AuthContext);
    const navigate = useNavigate();

    useEffect(() => {
        const query = new URLSearchParams(window.location.search);
        const code = query.get('code');
        if (code) {
            // Send code to backend
            fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            })
                .then(res => res.json())
                .then(data => {
                    // On success, update context and redirect home
                    login(data.user, data.token);
                    navigate('/', { replace: true }); // go to home or dashboard
                })
                .catch(err => console.error(err));
        }
    }, [login, navigate]);

    return <div>Logging you in...</div>;
}

export default OAuth2RedirectHandler;