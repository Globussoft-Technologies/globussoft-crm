import React, { useState, useEffect, useContext } from 'react';
import { io } from 'socket.io-client';
import { AuthContext } from '../App';

let socket;

export default function Presence() {
  const { user } = useContext(AuthContext);
  const [cursors, setCursors] = useState({});

  useEffect(() => {
    if (!user) return;
    
    // Connect to global WS multiplex
    socket = io('http://localhost:5000');
    
    socket.emit('join_presence', { userId: user.id || Math.random(), name: user.name || 'Anonymous' });

    socket.on('cursor_update', (data) => {
      setCursors(prev => ({ ...prev, [data.id]: data }));
    });

    socket.on('user_left', (id) => {
      setCursors(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    let throttleTimer;
    const handleMouseMove = (e) => {
      // Throttle mousemove emissions to 30ms (~30fps) for performance scaling
      if (throttleTimer) return;
      
      const rx = e.clientX / window.innerWidth;
      const ry = e.clientY / window.innerHeight;
      
      socket.emit('mouse_move', { rx, ry });
      
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
      }, 30);
    };

    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if(throttleTimer) clearTimeout(throttleTimer);
      socket.disconnect();
    };
  }, [user]);

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 999999 }}>
      {Object.values(cursors).map(c => {
        const left = c.rx * window.innerWidth;
        const top = c.ry * window.innerHeight;
        return (
          <div key={c.id} style={{ position: 'absolute', left, top, transition: 'all 0.1s linear' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill={c.color} xmlns="http://www.w3.org/2000/svg" style={{ transform: 'rotate(-20deg) translate(-2px, -2px)', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}>
              <path d="M4 4L20 10.6667L12 12M4 4L10.6667 20L12 12M4 4Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
            <div style={{ background: c.color, color: '#fff', fontSize: '0.75rem', fontWeight: 'bold', padding: '0.2rem 0.6rem', borderRadius: '12px', marginTop: '0.5rem', marginLeft: '0.5rem', whiteSpace: 'nowrap', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}>
              {c.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
