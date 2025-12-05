# Google OAuth Implementation Guide

This guide provides a comprehensive, step-by-step approach to implementing Google OAuth 2.0 using React, Express, Prisma, and PostgreSQL, without relying on Passport.js.

## 1. Architecture Overview

The authentication flow follows the standard OAuth 2.0 Authorization Code flow.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Client as React Client
    participant Server as Express Server
    participant Google as Google OAuth
    participant DB as PostgreSQL

    User->>Client: Click "Login with Google"
    Client->>Google: Redirect to Consent Screen (response_type=code)
    User->>Google: Grant Permission
    Google->>Client: Redirect back with code
    Client->>Server: POST /api/auth/google { code }
    Server->>Google: Exchange code for access_token & id_token
    Google->>Server: Return tokens
    Server->>Google: Get User Profile (using access_token)
    Google->>Server: Return User Profile (email, name, picture)
    Server->>DB: Upsert User (Find by email or Create)
    DB->>Server: User Record
    Server->>Server: Generate App JWT / Session
    Server->>Client: Return App JWT + User Info
    Client->>Client: Store JWT (localStorage/Cookie) & Update UI
```

## 2. Prerequisites

-   **Node.js** & **npm** installed.
-   **PostgreSQL** database running.
-   **Google Cloud Account**.

## 3. Google Cloud Console Setup

1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  Create a new project (e.g., "My Auth App").
3.  Navigate to **APIs & Services > OAuth consent screen**.
    -   Select **External** (for testing) or **Internal**.
    -   Fill in App Name, Support Email, etc.
    -   Add scopes: `userinfo.email`, `userinfo.profile`.
    -   Add test users (your email) if in "External" mode.
4.  Navigate to **Credentials**.
    -   Click **Create Credentials > OAuth client ID**.
    -   Application type: **Web application**.
    -   **Authorized JavaScript origins**: `http://localhost:5173` (your React dev server).
    -   **Authorized redirect URIs**: `http://localhost:5173/auth/callback` (where Google redirects back).
5.  **Copy** the `Client ID` and `Client Secret`. You will need these for your `.env` file.

## 4. Backend Implementation (Express + Prisma)

### 4.1. Initialize Project

```bash
mkdir server
cd server
npm init -y
npm install express cors dotenv prisma @prisma/client jsonwebtoken axios
npx prisma init
```

### 4.2. Database Schema (`prisma/schema.prisma`)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  picture   String?
  googleId  String?  @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Run migration:
```bash
npx prisma migrate dev --name init
```

### 4.3. Environment Variables (`.env`)

```env
DATABASE_URL="postgresql://user:password@localhost:5432/mydb?schema=public"
GOOGLE_CLIENT_ID="your_google_client_id"
GOOGLE_CLIENT_SECRET="your_google_client_secret"
JWT_SECRET="your_super_secret_jwt_key"
CLIENT_URL="http://localhost:5173"
```

### 4.4. Google OAuth Utility (`utils/googleClient.js`)

```javascript
const axios = require('axios');

const getGoogleOauthToken = async ({ code }) => {
  const rootURl = 'https://oauth2.googleapis.com/token';

  const options = {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${process.env.CLIENT_URL}/auth/callback`, // Must match Console
    grant_type: 'authorization_code',
  };

  try {
    const { data } = await axios.post(rootURl, options, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return data;
  } catch (err) {
    console.error('Failed to fetch Google Oauth Tokens', err.response.data);
    throw new Error(err.message);
  }
};

const getGoogleUser = async ({ id_token, access_token }) => {
  try {
    const { data } = await axios.get(
      `https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=${access_token}`,
      {
        headers: {
          Authorization: `Bearer ${id_token}`,
        },
      }
    );
    return data;
  } catch (err) {
    console.error('Failed to fetch Google User', err.response.data);
    throw new Error(err.message);
  }
};

module.exports = { getGoogleOauthToken, getGoogleUser };
```

### 4.5. Auth Controller (`controllers/auth.controller.js`)

```javascript
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const { getGoogleOauthToken, getGoogleUser } = require('../utils/googleClient');

const prisma = new PrismaClient();

const googleLoginHandler = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ message: 'Authorization code not provided' });
    }

    // 1. Exchange code for tokens
    const { id_token, access_token } = await getGoogleOauthToken({ code });

    // 2. Get user info from Google
    const googleUser = await getGoogleUser({ id_token, access_token });

    if (!googleUser.verified_email) {
      return res.status(403).json({ message: 'Google account not verified' });
    }

    // 3. Upsert User in DB
    const user = await prisma.user.upsert({
      where: { email: googleUser.email },
      update: {
        name: googleUser.name,
        picture: googleUser.picture,
        googleId: googleUser.id,
      },
      create: {
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture,
        googleId: googleUser.id,
      },
    });

    // 4. Create JWT
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    // 5. Send token & user back
    res.status(200).json({ token, user });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Something went wrong' });
  }
};

module.exports = { googleLoginHandler };
```

### 4.6. Server Entry Point (`server.js`)

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { googleLoginHandler } = require('./controllers/auth.controller');

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());

// Routes
app.post('/api/auth/google', googleLoginHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

## 5. Frontend Implementation (React)

### 5.1. Initialize Project

```bash
npm create vite@latest client -- --template react
cd client
npm install axios react-router-dom
```

### 5.2. Environment Variables (`.env`)

```env
VITE_GOOGLE_CLIENT_ID="your_google_client_id"
VITE_GOOGLE_REDIRECT_URI="http://localhost:5173/auth/callback"
VITE_API_URL="http://localhost:4000/api"
```

### 5.3. Login Component (`src/pages/Login.jsx`)

```jsx
import React from 'react';

const Login = () => {
  const googleLogin = () => {
    const getGoogleAuthUrl = () => {
      const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
      const options = {
        redirect_uri: import.meta.env.VITE_GOOGLE_REDIRECT_URI,
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        access_type: 'offline',
        response_type: 'code',
        prompt: 'consent',
        scope: [
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/userinfo.email',
        ].join(' '),
      };
      const qs = new URLSearchParams(options);
      return `${rootUrl}?${qs.toString()}`;
    };

    window.location.href = getGoogleAuthUrl();
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '50px' }}>
      <button onClick={googleLogin} style={{ padding: '10px 20px', fontSize: '16px' }}>
        Login with Google
      </button>
    </div>
  );
};

export default Login;
```

### 5.4. Callback Component (`src/pages/GoogleCallback.jsx`)

```jsx
import React, { useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const GoogleCallback = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const code = searchParams.get('code');
  const processedRef = useRef(false); // Prevent double execution in React.StrictMode

  useEffect(() => {
    if (code && !processedRef.current) {
      processedRef.current = true;
      const login = async () => {
        try {
          const { data } = await axios.post(`${import.meta.env.VITE_API_URL}/auth/google`, {
            code,
          });
          
          // Store token
          localStorage.setItem('token', data.token);
          localStorage.setItem('user', JSON.stringify(data.user));
          
          // Redirect to dashboard
          navigate('/dashboard');
        } catch (error) {
          console.error('Login failed', error);
          navigate('/login');
        }
      };
      login();
    }
  }, [code, navigate]);

  return <div>Processing login...</div>;
};

export default GoogleCallback;
```

### 5.5. App Routing (`src/App.jsx`)

```jsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import GoogleCallback from './pages/GoogleCallback';
import Dashboard from './pages/Dashboard'; // Create a simple dashboard

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<GoogleCallback />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/" element={<Login />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
```

## 6. Testing

1.  Start Backend: `node server.js` (Port 4000).
2.  Start Frontend: `npm run dev` (Port 5173).
3.  Navigate to `http://localhost:5173/login`.
4.  Click "Login with Google".
5.  Complete the Google flow.
6.  You should be redirected to `/dashboard` and see the token in LocalStorage.