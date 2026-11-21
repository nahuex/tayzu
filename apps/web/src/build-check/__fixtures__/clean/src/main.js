// Vite's built-in flags are not `VITE_*` variables: they carry no configuration.
export const isDev = import.meta.env.DEV;
export const mode = import.meta.env.MODE;
