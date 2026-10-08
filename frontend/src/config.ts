// Where the backend lives. By default it's the same computer that served this
// page, so the dashboard works on any device that opens it (laptop, central
// system, wall monitor). Set VITE_API_HOST in frontend/.env to override.
export const API_HOST: string = import.meta.env.VITE_API_HOST || window.location.hostname
export const API_URL = `http://${API_HOST}:8000`
export const WS_URL = `ws://${API_HOST}:8000`
