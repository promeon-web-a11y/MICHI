// 線だけのシンプルなアイコン（24px 基準）。色は currentColor。
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PinIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 21s-6.5-5.6-6.5-10.6a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z" />
    <circle cx="12" cy="10.2" r="2.3" />
  </Icon>
);

export const ArrowUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </Icon>
);

export const ArrowRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </Icon>
);

export const ArrowDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </Icon>
);

export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8h16" />
    <path d="M4 16h16" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 6 12 12" />
    <path d="M18 6 6 18" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const BookmarkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />
  </Icon>
);

export const ExternalIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 5h5v5" />
    <path d="m19 5-8 8" />
    <path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />
  </Icon>
);

// ---- ここから下は MICHI のデザインで追加したアイコン ----

export const SparkleIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3c.5 4.6 3.4 8.2 9 9-5.6.8-8.5 4.4-9 9-.5-4.6-3.4-8.2-9-9 5.6-.8 8.5-4.4 9-9Z" />
  </Icon>
);

export const SendIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 4 3.5 10.6l6.6 3.3 3.3 6.6L20 4Z" fill="currentColor" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const YenIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6.5 4 5.5 8 5.5-8" />
    <path d="M12 12v8" />
    <path d="M7.5 12.5h9" />
    <path d="M7.5 16h9" />
  </Icon>
);

export const HeartIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20Z" />
  </Icon>
);

export const StarIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8L12 3.8Z" />
  </Icon>
);

export const ShareIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="17.5" cy="5.5" r="2.5" />
    <circle cx="6.5" cy="12" r="2.5" />
    <circle cx="17.5" cy="18.5" r="2.5" />
    <path d="m8.7 10.7 6.6-3.9" />
    <path d="m8.7 13.3 6.6 3.9" />
  </Icon>
);

export const TransitIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5" y="3.5" width="14" height="13" rx="2.5" />
    <path d="M5 10.5h14" />
    <path d="M8.5 13.5h.01" />
    <path d="M15.5 13.5h.01" />
    <path d="m8 16.5-1.5 4" />
    <path d="m16 16.5 1.5 4" />
  </Icon>
);

export const UsersIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19.5c.4-3.3 2.8-5.3 6-5.3s5.6 2 6 5.3" />
    <path d="M15.5 5a3.2 3.2 0 0 1 0 6" />
    <path d="M17.5 14.5c2 .6 3.2 2.3 3.5 5" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </Icon>
);

export const CheckCircleIcon = (props: IconProps) => (
  <Icon {...props} stroke="none">
    <circle cx="12" cy="12" r="9" fill="currentColor" />
    <path d="m8 12.3 2.7 2.7 5.3-5.8" stroke="var(--background)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </Icon>
);

export const CautionIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4.5 3.5 19.5h17L12 4.5Z" />
    <path d="M12 10.5v4" />
    <path d="M12 17h.01" />
  </Icon>
);

export const MenuBookIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5" y="3.5" width="14" height="17" rx="2" />
    <path d="M9 8h6" />
    <path d="M9 12h6" />
    <path d="M9 16h3" />
  </Icon>
);

export const SpeechIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5a2 2 0 0 1-2-2v-8Z" />
  </Icon>
);

export const CardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <path d="M3 10h18" />
  </Icon>
);

export const CalendarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
    <path d="M4 10h16" />
    <path d="M8.5 3.5v4" />
    <path d="M15.5 3.5v4" />
  </Icon>
);

export const LeafIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 19c0-8 5-13.5 14.5-14.5C19 13 14 19 5 19Z" />
    <path d="M5 19c2.5-4.5 5.5-7.5 9.5-9.5" />
  </Icon>
);

export const LuggageIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="6" y="7.5" width="12" height="12" rx="2" />
    <path d="M9.5 7.5V4.5h5v3" />
    <path d="M10 11v5" />
    <path d="M14 11v5" />
  </Icon>
);

/** 詳細設定（条件の調整）を開くボタン */
export const TuneIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7.5h8" />
    <path d="M17 7.5h3" />
    <circle cx="14.5" cy="7.5" r="2.5" />
    <path d="M4 16.5h3" />
    <path d="M12 16.5h8" />
    <circle cx="9.5" cy="16.5" r="2.5" />
  </Icon>
);

export const MinusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
  </Icon>
);

export const DotsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 12h.01" />
    <path d="M12 12h.01" />
    <path d="M18 12h.01" />
  </Icon>
);
