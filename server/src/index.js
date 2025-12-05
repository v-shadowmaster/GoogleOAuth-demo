const express = require("express");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

const prisma = new PrismaClient();
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;


console.log(CLIENT_ID)
console.log(CLIENT_SECRET)
console.log(REDIRECT_URI)