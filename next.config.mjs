/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  async rewrites() { return [{ source: "/", destination: "/tablero.html" }, { source: "/login", destination: "/login.html" }]; },
};
