import React from "react";

/** Inline 24px stroke icons, drawn to one grid so weights match across the app. */
function Icon({ size = 16, children, ...rest }: { size?: number; children: React.ReactNode } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

type P = { size?: number };

export const HiveMark = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <path d="M34 12C35 4 50 2 54 14C48 12 41 11 34 12Z" />
      <path d="M26 22C29 11 54 12 58 26C48 23 37 22 28 24Z" />
      <path d="M30 27C42 24 60 28 61 39C56 37 51 37 46 38C45 29 37 28 33 32Z" />
      <path d="M44 42C53 40 62 44 61 52C53 49 43 50 34 53C41 49 44 47 44 42Z" />
      <path d="M20 57C25 52 48 51 58 55C63 61 26 63 20 58Z" />
    </g>
    <g fill="#F0BE55">
      <path d="M4 10C18 9 26 20 31 32C19 23 8 25 4 10Z" />
      <path d="M3 26C14 23 23 29 29 33C17 36 7 36 3 26Z" />
      <path d="M6 54C3 49 4 44 8 43C12 43 15 47 13 50C9 50 7 52 6 54Z" />
      <path d="M10 40C14 37 19 40 21 44C20 47 17 49 15 49C17 43 14 40 10 40Z" />
      <path d="M17 35C22 32 27 34 29 38C28 42 24 44 23 44C25 39 22 35 17 35Z" />
      <path d="M26 34C33 31 35 37 32 43C30 47 26 49 22 49C28 44 30 39 26 34Z" />
      <ellipse cx="36" cy="35" rx="4.1" ry="5.4" transform="rotate(-20 36 35)" />
    </g>
    <path d="M36 29C37 25 40 24 42 25M39 31C42 28 45 28 46 30" fill="none" stroke="#F0BE55" strokeWidth="2.3" strokeLinecap="round" />
  </svg>
);
export const PenIcon = ({ size }: P) => <Icon size={size}><path d="M12 20h9" /><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
export const SearchIcon = ({ size }: P) => <Icon size={size}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
export const ChatIcon = ({ size }: P) => <Icon size={size}><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" /></Icon>;
export const CodeIcon = ({ size }: P) => <Icon size={size}><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m13.5 5-3 14" /></Icon>;
export const ColumnsIcon = ({ size }: P) => <Icon size={size}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M12 4v16" /></Icon>;
export const PulseIcon = ({ size }: P) => <Icon size={size}><path d="M3 12h4l3-8 4 16 3-8h4" /></Icon>;
export const GearIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Icon>
);
export const FolderIcon = ({ size }: P) => <Icon size={size}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Icon>;
export const SidebarIcon = ({ size }: P) => <Icon size={size}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></Icon>;
export const ArrowUpIcon = ({ size }: P) => <Icon size={size} strokeWidth="2.2"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Icon>;
export const StopIcon = ({ size }: P) => <Icon size={size}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></Icon>;
export const CopyIcon = ({ size }: P) => <Icon size={size}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" /></Icon>;
export const CheckIcon = ({ size }: P) => <Icon size={size}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>;
export const RefreshIcon = ({ size }: P) => <Icon size={size}><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 21v-5h-5" /></Icon>;
export const ChevronDownIcon = ({ size }: P) => <Icon size={size}><path d="m6 9 6 6 6-6" /></Icon>;
export const BookIcon = ({ size }: P) => <Icon size={size}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2Z" /><path d="M4 19V5" /><path d="M9 7h6" /></Icon>;
export const ListIcon = ({ size }: P) => <Icon size={size}><path d="m4 6 1.5 1.5L8 5" /><path d="m4 12 1.5 1.5L8 11" /><path d="m4 18 1.5 1.5L8 17" /><path d="M11 6h9M11 12h9M11 18h9" /></Icon>;
export const DiffIcon = ({ size }: P) => <Icon size={size}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5V15a3 3 0 0 0 3 3h6.5" /><path d="M18 15.5V9a3 3 0 0 0-3-3H8.5" /></Icon>;
export const FlaskIcon = ({ size }: P) => <Icon size={size}><path d="M9 3h6" /><path d="M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path d="M7 15h10" /></Icon>;
export const KeyIcon = ({ size }: P) => <Icon size={size}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9" /><path d="m16 7 3 3" /></Icon>;
export const SlidersIcon = ({ size }: P) => <Icon size={size}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></Icon>;
export const CubeIcon = ({ size }: P) => <Icon size={size}><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" /><path d="M12 12 20 7.5M12 12 4 7.5M12 12v9" /></Icon>;
export const BoltIcon = ({ size }: P) => <Icon size={size}><path d="M13 2 4 14h7l-1 8 9-12h-7Z" /></Icon>;
export const ArrowRightIcon = ({ size }: P) => <Icon size={size}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></Icon>;
export const CloseIcon = ({ size }: P) => <Icon size={size}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const ArchiveIcon = ({ size }: P) => <Icon size={size}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></Icon>;
export const ShieldIcon = ({ size }: P) => <Icon size={size}><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6Z" /></Icon>;
export const MoreIcon = ({ size }: P) => <Icon size={size} strokeWidth="3"><path d="M5 12h.01M12 12h.01M19 12h.01" /></Icon>;
export const ExpandIcon = ({ size }: P) => <Icon size={size}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></Icon>;
export const CollapseIcon = ({ size }: P) => <Icon size={size}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></Icon>;
