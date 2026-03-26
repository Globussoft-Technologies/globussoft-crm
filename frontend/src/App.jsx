import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import Pipeline from './pages/Pipeline';
import Workflows from './pages/Workflows';
export default function App() {
  return (<BrowserRouter><Routes>
    <Route path="/" element={<Dashboard />} />
    <Route path="/contacts" element={<Contacts />} />
    <Route path="/pipeline" element={<Pipeline />} />
    <Route path="/workflows" element={<Workflows />} />
  </Routes></BrowserRouter>);
}