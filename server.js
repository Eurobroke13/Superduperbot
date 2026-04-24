import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_, res) => res.send("Live"));

app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
