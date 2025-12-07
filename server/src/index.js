const express = require("express");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const dotenv = require("dotenv");

const path = require("path");
dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();
app.use(express.json());

const prisma = new PrismaClient();
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;


// google oauth route
app.post("/api/auth/google", async (req, res) => {
    try {
        const { code } = req.body;

        // 1. Exchange code for tokens at Google
        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', null, {
            params: {
                code: code,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code',
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });


        const { access_token, id_token } = tokenResponse.data;

        // 2. Use the access token to get user info from Google
        const userInfoResponse = await axios.get(
            `https://www.googleapis.com/oauth2/v2/userinfo?access_token=${access_token}`,
            { headers: { Authorization: `Bearer ${id_token}` } }
        );
        const { email, name, picture } = userInfoResponse.data;

        // 3. Upsert the user into the database using Prisma
        const user = await prisma.user.upsert({
            where: { email: email },
            update: { name: name, avatar: picture },
            create: { email: email, name: name, avatar: picture }
        });

        // 4. Return user info and token to the client
        res.json({ user, token: access_token });

    } catch (error) {
        console.error('Error during Google OAuth flow:', error.response?.data || error.message);
        res.status(500).json({ error: 'Authentication failed' });
    }
})

const PORT = 5000

app.listen(PORT, () => console.log(`server started at the port : ${PORT}`));