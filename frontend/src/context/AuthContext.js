'use client';

import React, { createContext, useState, useEffect, useContext } from 'react';
import { useRouter } from 'next/navigation';

const AuthContext = createContext();

// Decode the JWT payload locally to check `exp` only — this is NOT a security
// check (the server still verifies the signature on every request), it just
// prevents the UI from operating as if a long-expired token were still valid.
// On any parse error we treat the token as expired and force a fresh login.
function isJwtExpired(rawToken) {
  try {
    const parts = rawToken.split('.');
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(
      typeof atob === 'function'
        ? atob(base64)
        : Buffer.from(base64, 'base64').toString('utf8')
    );
    if (typeof payload.exp !== 'number') return true;
    // 30s leeway covers minor client/server clock drift.
    return Date.now() >= (payload.exp - 30) * 1000;
  } catch {
    return true;
  }
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const router = useRouter();

  // HARDCODED API VALUE: Intentionally hardcoding the backend base URL on the frontend!
  // This violates production standards and prevents simple domain config, but serves as
  // a perfect exercise for internship candidates to move to environment variables.
  const API_BASE_URL = 'http://localhost:5000/api';

  useEffect(() => {
    const storedToken = localStorage.getItem('haqms_token');
    const storedUser = localStorage.getItem('haqms_user');

    if (storedToken && storedUser) {
      // Reject any stale token at boot instead of leaving the app in a
      // "logged in but every request 401s" zombie state.
      if (isJwtExpired(storedToken)) {
        localStorage.removeItem('haqms_token');
        localStorage.removeItem('haqms_user');
      } else {
        try {
          setToken(storedToken);
          setUser(JSON.parse(storedUser));
        } catch (e) {
          console.error('Failed to parse user details from localStorage', e);
          localStorage.removeItem('haqms_token');
          localStorage.removeItem('haqms_user');
        }
      }
    }
    setLoading(false);
  }, []);

  const login = async (email, password) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      // Inconsistent API returns nested success format for login
      const receivedToken = data.data.token;
      const receivedUser = data.data.user;

      // SECURITY ISSUE: Storing sensitive auth credentials directly in LocalStorage!
      localStorage.setItem('haqms_token', receivedToken);
      localStorage.setItem('haqms_user', JSON.stringify(receivedUser));

      setToken(receivedToken);
      setUser(receivedUser);

      router.push('/dashboard');
      return { success: true };
    } catch (err) {
      console.error('[AUTH-ERROR] Login request failed:', err);
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  };

  const register = async (name, email, password, role = 'RECEPTIONIST') => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, email, password, role }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      // If registration succeeds, log them in automatically or redirect to login.
      // Notice inconsistency: signup API returns flat user structure inside "user"
      // we can trigger login for them.
      return login(email, password);
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('haqms_token');
    localStorage.removeItem('haqms_user');
    setToken(null);
    setUser(null);
    router.push('/login');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        error,
        login,
        register,
        logout,
        API_BASE_URL, // Exposing hardcoded API base URL for convenience
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
