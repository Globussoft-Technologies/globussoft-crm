require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Global Middlewares
app.use(cors({ origin: "*" }));
app.use(express.json());

// Socket.io Real-time Setup
const io = new Server(server, { cors: { origin: "*" } });

// Attach socket to requests so routes can emit events
app.use((req, res, next) => {
  req.io = io;
  next();
});

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  
  socket.on("join_room", (room) => {
    socket.join(room);
    console.log(`[Socket] ${socket.id} joined room ${room}`);
  });

  socket.on("disconnect", () => console.log(`[Socket] Client disconnected: ${socket.id}`));
});

// Import Enterprise Routes
const authRoutes = require("./routes/auth");
const contactsRoutes = require("./routes/contacts");
const dealsRoutes = require("./routes/deals");
const calendarRoutes = require("./routes/calendar");

// Map API Endpoints
app.use("/api/auth", authRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/deals", dealsRoutes);
app.use("/api/calendar", calendarRoutes);

app.get("/", (req, res) => {
  res.json({ message: "Enterprise CRM API Core Online", version: "2.0.0" });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`[Backend] Enterprise Express Server running securely on port ${PORT}`);
});
