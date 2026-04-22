import express from "express";

const app = express();

app.get("/", (_, res) => res.send("Live"));

app.listen(process.env.PORT || 3000);
