import type { ReactNode } from 'react';

type IconName =
  | 'arrow'
  | 'braces'
  | 'check'
  | 'chevron'
  | 'copy'
  | 'edit'
  | 'folder'
  | 'layers'
  | 'list'
  | 'menu'
  | 'more'
  | 'panel'
  | 'plus'
  | 'refresh'
  | 'shield'
  | 'shuffle'
  | 'square'
  | 'trash'
  | 'triangle'
  | 'user'
  | 'wrench'
  | 'x';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="m5 12 7-7 7 7M12 5v14" />,
    braces: <path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2m8-16h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    copy: <><rect width="12" height="12" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    layers: <><path d="m12.83 2.18 8 4a1 1 0 0 1 0 1.79l-8 4a2 2 0 0 1-1.66 0l-8-4a1 1 0 0 1 0-1.79l8-4a2 2 0 0 1 1.66 0Z" /><path d="m22 12.5-9.17 4.59a2 2 0 0 1-1.66 0L2 12.5m20 5-9.17 4.59a2 2 0 0 1-1.66 0L2 17.5" /></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>,
    panel: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18M9 9h12" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 9a7 7 0 0 0-11.7-2.6L4 11m16 2-2.8 4.6A7 7 0 0 1 5.5 15" /></>,
    shield: <><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z" /><path d="m9 12 2 2 4-4" /></>,
    shuffle: <><path d="m18 14 4 4-4 4" /><path d="m18 2 4 4-4 4" /><path d="M2 18h1.4a8 8 0 0 0 6.7-3.6l3.8-5.8A8 8 0 0 1 20.6 5H22M2 6h1.9a8 8 0 0 1 6.7 3.6l.7 1" /></>,
    square: <rect width="12" height="12" x="6" y="6" rx="1" fill="currentColor" stroke="none" />,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7" /></>,
    triangle: <><path d="M21.7 16 14 2.7a2.3 2.3 0 0 0-4 0L2.3 16A2.3 2.3 0 0 0 4.3 19h15.4a2.3 2.3 0 0 0 2-3Z" /><path d="M12 9v4m0 3h.01" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />,
    x: <path d="m6 6 12 12M18 6 6 18" />,
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {paths[name]}
    </svg>
  );
}

export { Icon, type IconName };

// Next treats files named `icon.tsx` as metadata routes and requires a default
// export. Keep the reusable named component API unchanged for the chat UI.
export default function IconRoute() {
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/></svg>',
    { headers: { 'content-type': 'image/svg+xml' } },
  );
}
