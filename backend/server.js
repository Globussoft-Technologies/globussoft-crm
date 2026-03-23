const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
const contactsRoutes = require('./routes/contacts');
const dealsRoutes = require('./routes/deals');
const supportRoutes = require('./routes/support');
const marketingRoutes = require('./routes/marketing');

app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/deals', dealsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/marketing', marketingRoutes);

// Base route for testing
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Globussoft CRM API' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
