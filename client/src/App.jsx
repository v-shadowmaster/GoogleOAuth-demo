import React, { useContext } from 'react';
import { AuthContext } from './AuthContext';
import LoginButton from './LoginButton';
import OAuth2RedirectHandler from './OAuth2RedirectHandler';

function App() {
  const { user, logout } = useContext(AuthContext);

  if (window.location.pathname === '/oauth2/redirect') {
    return <OAuth2RedirectHandler />;
  }

  return (
    <div>
      {user ? (
        <div>
          <p>Welcome, {user.name}!</p>
          <button onClick={logout}>Logout</button>
        </div>
      ) : (
        <LoginButton />
      )}
    </div>
  );
}
export default App;