import axios from 'axios';
import { store } from '../store';
import { logout } from '../store/slices/authSlice';
import { clearNotes } from '../store/slices/notesSlice';
import debounce from 'lodash/debounce';

// Keep track of last API call times to prevent too many requests
const apiCallTimestamps = {
  notes: 0
};

// Minimum time between API calls to same endpoint in ms
const API_RATE_LIMIT = 500;

const api = axios.create({
  baseURL: 'http://localhost:5000/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add rate limiting protection
const callWithRateLimit = async (endpoint, apiCall) => {
  const now = Date.now();
  const category = endpoint.split('/')[1] || 'default'; // Extract the main part of the endpoint
  const lastCallTime = apiCallTimestamps[category] || 0;
  const timeSinceLastCall = now - lastCallTime;
  
  // If we've made a call too recently, wait before making the next one
  if (timeSinceLastCall < API_RATE_LIMIT) {
    const delay = API_RATE_LIMIT - timeSinceLastCall;
    console.log(`Rate limiting ${category} API call, waiting ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  // Update the timestamp for this endpoint
  apiCallTimestamps[category] = Date.now();
  
  // Make the actual API call
  return apiCall();
};

// Add auth token to requests
api.interceptors.request.use(
  (config) => {
    const token = store.getState().auth.token;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      store.dispatch(logout());
      store.dispatch(clearNotes());
    }
    // Format error message
    const message = error.response?.data?.message || error.message;
    error.message = message;
    return Promise.reject(error);
  }
);

// Debounce API calls
const debouncedGet = debounce((url, config) => api.get(url, config), 300);

export const authAPI = {
  login: async (email, password) => {
    try {
      const response = await api.post('/auth/login', { email, password });
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Login failed');
    }
  },
  register: async (name, email, password) => {
    try {
      const response = await api.post('/auth/register', { name, email, password });
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Registration failed');
    }
  },
};

export const notesAPI = {
  getAllNotes: async (page = 1, limit = 10, showArchived = false) => {
    try {
      console.log('Fetching notes with params:', { page, limit, showArchived });
      // Use rate limiting for API calls
      const response = await callWithRateLimit('/notes', () => 
        api.get('/notes', {
          params: { page, limit, showArchived }
        })
      );
      console.log('Got notes response:', response.data);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch notes:', error);
      throw new Error(error.response?.data?.message || 'Failed to fetch notes');
    }
  },
  getNote: async (id) => {
    try {
      const response = await callWithRateLimit(`/notes/${id}`, () => 
        api.get(`/notes/${id}`)
      );
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to fetch note');
    }
  },
  createNote: async (title, content = '') => {
    try {
      const response = await callWithRateLimit('/notes', () => 
        api.post('/notes', { 
          title: title.trim(),
          content: content.trim() || 'New note'
        })
      );
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to create note');
    }
  },
  updateNote: async (id, data) => {
    try {
      const response = await callWithRateLimit(`/notes/${id}`, () => 
        api.patch(`/notes/${id}`, data)
      );
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to update note');
    }
  },
  deleteNote: async (id) => {
    try {
      const response = await callWithRateLimit(`/notes/${id}`, () => 
        api.delete(`/notes/${id}`)
      );
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to delete note');
    }
  },
  shareNote: async (id, email, permission) => {
    try {
      const response = await callWithRateLimit(`/notes/${id}/share`, () => 
        api.post(`/notes/${id}/share`, { email, permission })
      );
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Failed to share note');
    }
  },
}; 