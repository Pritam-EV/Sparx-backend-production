// utils/authUtils.js

// Decode JWT without verification (client-side check)
const decodeToken = (token) => {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (error) {
    return null;
  }
};

// Check if token is expired
export const isTokenExpired = (token) => {
  if (!token) return true;
  
  const decoded = decodeToken(token);
  if (!decoded || !decoded.exp) return true;
  
  const currentTime = Date.now() / 1000;
  return decoded.exp < currentTime;
};

// Auto-logout function
export const handleAutoLogout = (navigate) => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  navigate('/login');
};

// Check token validity and auto-logout if expired
export const checkTokenAndLogout = (navigate) => {
  const token = localStorage.getItem('token');
  
  if (isTokenExpired(token)) {
    console.log('Token expired - logging out');
    handleAutoLogout(navigate);
    return false;
  }
  return true;
};
