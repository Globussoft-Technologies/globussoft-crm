const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ error: "Access Denied" });
  
  const token = authHeader.split(" ")[1];
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid Authentication Token" });
  }
};

const verifyRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient Role Permissions. System Admin Required." });
    }
    next();
  };
};

module.exports = { verifyToken, verifyRole };
