import express from "express";
import dotenv from "dotenv";
import extractRouter from "./extractDetails.js";
import replyRouter from "./replySender.js";
import connectRouter from "./connectReuestSender.js";

dotenv.config();

const app = express();
app.use(express.json());

app.use("/extract", extractRouter);
app.use("/reply", replyRouter);
app.use("/connect", connectRouter);

const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Unified LinkedIn Automation API running on port ${PORT}`);
});
