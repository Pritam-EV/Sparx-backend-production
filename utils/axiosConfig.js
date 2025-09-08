// utils/axiosConfig.js
import axios from 'axios';
import { handleAutoLogout } from './authUtils';

const setupAxiosInterceptors = (navigate) => {
  axios.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401 && error.response?.data?.expired) {
        console.log('Token expired from server response');
        handleAutoLogout(navigate);
      }
      return Promise.reject(error);
    }
  );
};

export default setupAxiosInterceptors;
