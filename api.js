// api.js

import axios from 'axios';

const API_URL = 'https://ev-charging-a5c53.web.app/'; // Replace with your backend API URL

export const getDevices = () => axios.get(`${API_URL}/devices`);
