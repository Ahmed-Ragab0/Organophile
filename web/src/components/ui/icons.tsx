/**
 * The navigation icon set.
 *
 * Hand-drawn rather than pulled from a library: fifteen 24px glyphs are far
 * less weight than an icon package, they cannot drift in stroke weight between
 * releases, and `currentColor` means they inherit the nav's active/hover
 * colours with no extra plumbing.
 *
 * House rules, so a new glyph never looks pasted in: 24×24 box, 1.6 stroke,
 * round caps and joins, no fills.
 */

type IconProps = { className?: string };

function Svg({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-[18px] w-[18px] shrink-0'}
    >
      {children}
    </svg>
  );
}

/** Overview — four panels, the shape of a dashboard. */
export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
  </Svg>
);

export const IconWallet = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2" />
    <rect x="3" y="8" width="18" height="12" rx="2.5" />
    <path d="M21 12.5h-4a1.75 1.75 0 0 0 0 3.5h4" />
  </Svg>
);

/** Ledger — a bound book of lines. */
export const IconLedger = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5z" />
    <path d="M5 17h14" />
    <path d="M9 7.5h6M9 11h6" />
  </Svg>
);

export const IconExpenses = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v9M8.5 13l3.5 3.5 3.5-3.5" />
  </Svg>
);

export const IconReports = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="M8 16v-4M12.5 16V7.5M17 16v-6" />
  </Svg>
);

export const IconStudents = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.25" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.6a3.25 3.25 0 0 1 0 6.3" />
    <path d="M17.5 14.4a5.5 5.5 0 0 1 3 5.1" />
  </Svg>
);

export const IconCourses = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 7.5 3.5 4.75 12 2l8.5 2.75z" />
    <path d="M6.5 9.5v5.25c0 1.8 2.46 3.25 5.5 3.25s5.5-1.45 5.5-3.25V9.5" />
    <path d="M20.5 5v6" />
  </Svg>
);

/** Classification — a label tied onto something. */
export const IconClassification = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.6 3H6.5A3.5 3.5 0 0 0 3 6.5v5.1a2 2 0 0 0 .59 1.41l7.4 7.4a2 2 0 0 0 2.82 0l5.1-5.1a2 2 0 0 0 0-2.82l-7.4-7.4A2 2 0 0 0 11.6 3z" />
    <circle cx="8.1" cy="8.1" r="1.35" />
  </Svg>
);

export const IconSubscriptions = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5v2a2 2 0 0 0 0 3.9v2A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.4v-2a2 2 0 0 0 0-3.9z" />
    <path d="M14 7v11" strokeDasharray="2 2.4" />
  </Svg>
);

/** Pricing — a price tag. */
export const IconPricing = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 11.4V4.8A1.3 1.3 0 0 1 4.8 3.5h6.6a1.3 1.3 0 0 1 .92.38l8.2 8.2a1.3 1.3 0 0 1 0 1.84l-6.6 6.6a1.3 1.3 0 0 1-1.84 0l-8.2-8.2a1.3 1.3 0 0 1-.38-.92z" />
    <circle cx="7.9" cy="7.9" r="1.4" />
  </Svg>
);

/** Journey — the path an order takes, with a stop on the way. */
export const IconJourney = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="6" r="2.25" />
    <circle cx="19" cy="18" r="2.25" />
    <path d="M7.25 6H14a3.5 3.5 0 0 1 0 7h-4a3.5 3.5 0 0 0 0 7h6.75" />
  </Svg>
);

export const IconPayments = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.75" y="5" width="18.5" height="14" rx="2.5" />
    <path d="M2.75 9.75h18.5" />
    <path d="M6.5 15h3" />
  </Svg>
);

/** Payouts — money leaving for the bank. */
export const IconPayouts = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 9.5 12 4l9 5.5" />
    <path d="M5 10v7M10 10v7M14 10v7M19 10v7" />
    <path d="M3 20h18" />
  </Svg>
);

export const IconReconciliation = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12.5 6.5 16 13 8.5" />
    <path d="M11 15.5 13.5 18 21 8.5" />
  </Svg>
);

export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15.5V3.5" />
    <path d="M8 7.5 12 3.5l4 4" />
    <path d="M4 14.5v3A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-3" />
  </Svg>
);

/**
 * Lists & settings — three rows with a handle on one of them.
 *
 * Not a cog: nothing on that page is a switch. It is lists you add rows to,
 * and the mark should say so before the label does.
 */
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
    <circle cx="9" cy="7" r="1.9" />
    <circle cx="15" cy="17" r="1.9" />
  </Svg>
);

export const IconHealth = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12.5h4l2.5-6 4 12 2.5-6h5" />
  </Svg>
);

/** Live mode — a broadcasting dot. */
export const IconLive = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.25" />
    <path d="M6.7 6.7a7.5 7.5 0 0 0 0 10.6M17.3 17.3a7.5 7.5 0 0 0 0-10.6" />
  </Svg>
);

/** Test mode — a lab flask, which is also the subject of the business. */
export const IconTest = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 3v6.2L4.7 17.4A2 2 0 0 0 6.4 20.5h11.2a2 2 0 0 0 1.7-3.1L14.5 9.2V3" />
    <path d="M8.5 3h7" />
    <path d="M7.2 14.5h9.6" />
  </Svg>
);

/** System theme — a display, i.e. "whatever this machine says". */
export const IconSystemTheme = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.75" y="4" width="18.5" height="12.5" rx="2.5" />
    <path d="M8.5 20h7M12 16.5V20" />
  </Svg>
);

export const IconLight = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.22 4.22l1.56 1.56M18.22 18.22l1.56 1.56M2.5 12h2.2M19.3 12h2.2M4.22 19.78l1.56-1.56M18.22 5.78l1.56-1.56" />
  </Svg>
);

export const IconDark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 13.4A8.2 8.2 0 1 1 10.6 4a6.6 6.6 0 0 0 9.4 9.4z" />
  </Svg>
);

export const IconLanguage = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.4 9.5h17.2M3.4 14.5h17.2" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
  </Svg>
);

export const IconSignOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 8V6a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
    <path d="M20 12H10" />
    <path d="m17 9 3 3-3 3" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v4.5h-4.5" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const NAV_ICONS = {
  overview: IconOverview,
  wallets: IconWallet,
  ledger: IconLedger,
  expenses: IconExpenses,
  reports: IconReports,
  students: IconStudents,
  courses: IconCourses,
  classification: IconClassification,
  subscriptions: IconSubscriptions,
  pricing: IconPricing,
  journey: IconJourney,
  payments: IconPayments,
  payouts: IconPayouts,
  reconciliation: IconReconciliation,
  import: IconImport,
  settings: IconSettings,
  health: IconHealth,
} as const;

export type NavIconKey = keyof typeof NAV_ICONS;
