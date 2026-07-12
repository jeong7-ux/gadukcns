/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // FullCalendar ships ESM packages that Next transpiles from node_modules
  transpilePackages: [
    "@fullcalendar/core",
    "@fullcalendar/daygrid",
    "@fullcalendar/interaction",
    "@fullcalendar/react",
  ],
};

export default nextConfig;
