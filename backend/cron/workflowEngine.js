/**
 * Workflow Engine initializer.
 *
 * Event-driven (not polled). Stores the Socket.io reference so event handlers
 * can push real-time notifications. Call once at server startup.
 */

let _io = null;

function initWorkflowEngine(io) {
  _io = io;
  console.log("[WorkflowEngine] Initialized — listening for CRM events via eventBus");
}

function getIO() {
  return _io;
}

module.exports = { initWorkflowEngine, getIO };
