export const fetchApi = async (url, options = {}) => {
  const token = localStorage.getItem('token');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  // Use relative URL dynamically proxied by Nginx
  const response = await fetch(url, {
    ...options,
    headers,
  });
  
  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.message || 'API Request Failed');
  }
  
  if (options.method === 'DELETE' || response.status === 204) {
    return true;
  }
  
  return response.json();
};
