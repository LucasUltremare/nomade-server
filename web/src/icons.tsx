// Ícones de traço 1.5px, desenhados no grid de 20px.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const base = (d: React.ReactNode) => (p: P) => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    {d}
  </svg>
);

export const IconHome = base(<path d="M3.5 9 10 3.8 16.5 9v7.2h-4.3v-4.6H7.8v4.6H3.5z" />);
export const IconNodes = base(<><rect x="3.5" y="4" width="13" height="5" rx="1" /><rect x="3.5" y="11" width="13" height="5" rx="1" /><path d="M6 6.5h.01M6 13.5h.01" /></>);
export const IconVM = base(<><rect x="3" y="4" width="14" height="9.5" rx="1.2" /><path d="M7 16.5h6M10 13.5v3" /></>);
export const IconLXC = base(<><path d="M10 3 16.5 6.5v7L10 17l-6.5-3.5v-7z" /><path d="M3.5 6.5 10 10l6.5-3.5M10 10v7" /></>);
export const IconStorage = base(<><ellipse cx="10" cy="5.5" rx="6" ry="2.3" /><path d="M4 5.5v9c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3v-9M4 10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3" /></>);
export const IconNetwork = base(<><circle cx="10" cy="4.5" r="1.8" /><circle cx="4.5" cy="15.5" r="1.8" /><circle cx="15.5" cy="15.5" r="1.8" /><path d="M10 6.3v3.2M10 9.5l-4.4 4.4M10 9.5l4.4 4.4" /></>);
export const IconShield = base(<path d="M10 3 16 5.3v4.5c0 3.4-2.6 6-6 7.2-3.4-1.2-6-3.8-6-7.2V5.3z" />);
export const IconTerminal = base(<><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="m6.5 8 2.3 2-2.3 2M10.5 12.5h3" /></>);
export const IconSearch = base(<><circle cx="9" cy="9" r="5" /><path d="m13 13 3.5 3.5" /></>);
export const IconBell = base(<path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.2 1.5H4.3zM8.5 17h3" />);
export const IconCalendar = base(<><rect x="3.5" y="4.5" width="13" height="12" rx="1.5" /><path d="M3.5 8.5h13M7 3v3M13 3v3" /></>);
export const IconSidebar = base(<><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M8 4v12" /></>);
export const IconStar = base(<path d="m10 3.2 2 4.3 4.6.5-3.4 3.2.9 4.6L10 13.5l-4.1 2.3.9-4.6L3.4 8l4.6-.5z" />);
export const IconX = base(<path d="m5 5 10 10M15 5 5 15" />);
export const IconPlay = base(<path d="M6.5 4.5v11l9-5.5z" />);
export const IconPower = base(<><path d="M10 3v7" /><path d="M6 5.5a6 6 0 1 0 8 0" /></>);
export const IconRestart = base(<><path d="M15.5 10A5.5 5.5 0 1 1 13.8 6" /><path d="M14.5 3v3.5H11" /></>);
export const IconStop = base(<rect x="5" y="5" width="10" height="10" rx="1.5" />);
export const IconExternal = base(<path d="M8 4H4.5v11.5H16V12M11 4h5v5M16 4l-7 7" />);
export const IconLogout = base(<path d="M8 4H4.5v12H8M12 6.5 15.5 10 12 13.5M15.5 10H8" />);
export const IconBackup = base(<><path d="M4 7.5h12v8.5H4z" /><path d="M3 4h14v3.5H3zM8 10.5h4" /></>);
export const IconApps = base(<><rect x="3.5" y="3.5" width="5" height="5" rx="1.2" /><rect x="11.5" y="3.5" width="5" height="5" rx="1.2" /><rect x="3.5" y="11.5" width="5" height="5" rx="1.2" /><path d="M14 11.5v5M11.5 14h5" /></>);
export const IconDownload = base(<path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 16h12" />);
export const IconGrid = base(<><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.5" /><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.5" /><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.5" /><rect x="11" y="11" width="5.5" height="5.5" rx="1.5" /></>);
export const IconMinimize = base(<path d="M5 14h10" />);
