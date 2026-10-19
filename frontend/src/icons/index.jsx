// Named, tree-shakable equivalents for every Lucide icon used by this app.
// Keep exports in sync when introducing a new lucide-react import.
import { createThemedIcon } from './createThemedIcon';
import {
  Activity as LucideActivity,
  AlertCircle as LucideAlertCircle,
  AlertTriangle as LucideAlertTriangle,
  AlignCenter as LucideAlignCenter,
  AlignJustify as LucideAlignJustify,
  AlignLeft as LucideAlignLeft,
  AlignRight as LucideAlignRight,
  Archive as LucideArchive,
  ArchiveRestore as LucideArchiveRestore,
  ArrowDown as LucideArrowDown,
  ArrowDownLeft as LucideArrowDownLeft,
  ArrowDownToLine as LucideArrowDownToLine,
  ArrowLeft as LucideArrowLeft,
  ArrowRight as LucideArrowRight,
  ArrowRightCircle as LucideArrowRightCircle,
  ArrowRightLeft as LucideArrowRightLeft,
  ArrowUp as LucideArrowUp,
  ArrowUpDown as LucideArrowUpDown,
  ArrowUpFromLine as LucideArrowUpFromLine,
  ArrowUpRight as LucideArrowUpRight,
  AtSign as LucideAtSign,
  Award as LucideAward,
  BadgeCheck as LucideBadgeCheck,
  BadgePercent as LucideBadgePercent,
  Ban as LucideBan,
  Banknote as LucideBanknote,
  BarChart as LucideBarChart,
  BarChart3 as LucideBarChart3,
  BedDouble as LucideBedDouble,
  Bell as LucideBell,
  BellOff as LucideBellOff,
  Blocks as LucideBlocks,
  Bold as LucideBold,
  Book as LucideBook,
  BookOpen as LucideBookOpen,
  Bookmark as LucideBookmark,
  BookmarkPlus as LucideBookmarkPlus,
  Bot as LucideBot,
  Box as LucideBox,
  Boxes as LucideBoxes,
  Brain as LucideBrain,
  Briefcase as LucideBriefcase,
  BriefcaseBusiness as LucideBriefcaseBusiness,
  Building as LucideBuilding,
  Building2 as LucideBuilding2,
  Bus as LucideBus,
  Calculator as LucideCalculator,
  Calendar as LucideCalendar,
  CalendarCheck as LucideCalendarCheck,
  CalendarClock as LucideCalendarClock,
  CalendarDays as LucideCalendarDays,
  CalendarIcon as LucideCalendarIcon,
  CalendarOff as LucideCalendarOff,
  CalendarPlus as LucideCalendarPlus,
  CalendarRange as LucideCalendarRange,
  Camera as LucideCamera,
  Car as LucideCar,
  Check as LucideCheck,
  CheckCheck as LucideCheckCheck,
  CheckCircle as LucideCheckCircle,
  CheckCircle2 as LucideCheckCircle2,
  CheckSquare as LucideCheckSquare,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  Circle as LucideCircle,
  CircleCheck as LucideCircleCheck,
  CircleHelp as LucideCircleHelp,
  Clipboard as LucideClipboard,
  ClipboardCheck as LucideClipboardCheck,
  ClipboardList as LucideClipboardList,
  Clock as LucideClock,
  Clock3 as LucideClock3,
  Cloud as LucideCloud,
  CloudLightning as LucideCloudLightning,
  Code as LucideCode,
  Code2 as LucideCode2,
  Coins as LucideCoins,
  Columns as LucideColumns,
  Compass as LucideCompass,
  Construction as LucideConstruction,
  Copy as LucideCopy,
  CopyPlus as LucideCopyPlus,
  CornerDownLeft as LucideCornerDownLeft,
  CornerUpLeft as LucideCornerUpLeft,
  Cpu as LucideCpu,
  CreditCard as LucideCreditCard,
  Crosshair as LucideCrosshair,
  Crown as LucideCrown,
  Database as LucideDatabase,
  DollarSign as LucideDollarSign,
  Download as LucideDownload,
  Edit as LucideEdit,
  Edit2 as LucideEdit2,
  Edit3 as LucideEdit3,
  ExternalLink as LucideExternalLink,
  Eye as LucideEye,
  EyeOff as LucideEyeOff,
  Facebook as LucideFacebook,
  FileBarChart as LucideFileBarChart,
  FileCheck as LucideFileCheck,
  FileCheck2 as LucideFileCheck2,
  FileDigit as LucideFileDigit,
  FileDown as LucideFileDown,
  FileEdit as LucideFileEdit,
  FileImage as LucideFileImage,
  FileInput as LucideFileInput,
  FileJson as LucideFileJson,
  FileSignature as LucideFileSignature,
  FileSpreadsheet as LucideFileSpreadsheet,
  FileStack as LucideFileStack,
  FileText as LucideFileText,
  FileUp as LucideFileUp,
  Film as LucideFilm,
  Filter as LucideFilter,
  Flag as LucideFlag,
  Flame as LucideFlame,
  Folder as LucideFolder,
  FolderKanban as LucideFolderKanban,
  FolderOpen as LucideFolderOpen,
  FolderPlus as LucideFolderPlus,
  FolderTree as LucideFolderTree,
  Forward as LucideForward,
  Gift as LucideGift,
  GitBranch as LucideGitBranch,
  GitMerge as LucideGitMerge,
  Github as LucideGithub,
  Globe as LucideGlobe,
  Globe2 as LucideGlobe2,
  GraduationCap as LucideGraduationCap,
  Grid as LucideGrid,
  Grid3X3 as LucideGrid3X3,
  Grid3x3 as LucideGrid3x3,
  GripVertical as LucideGripVertical,
  HandCoins as LucideHandCoins,
  Handshake as LucideHandshake,
  Hash as LucideHash,
  Heading as LucideHeading,
  Heart as LucideHeart,
  HeartHandshake as LucideHeartHandshake,
  HeartPulse as LucideHeartPulse,
  HelpCircle as LucideHelpCircle,
  History as LucideHistory,
  Home as LucideHome,
  Hotel as LucideHotel,
  Hourglass as LucideHourglass,
  Image as LucideImage,
  ImagePlus as LucideImagePlus,
  Import as LucideImport,
  Inbox as LucideInbox,
  Indent as LucideIndent,
  IndianRupee as LucideIndianRupee,
  Info as LucideInfo,
  Italic as LucideItalic,
  Key as LucideKey,
  KeyRound as LucideKeyRound,
  Keyboard as LucideKeyboard,
  Landmark as LucideLandmark,
  Layers as LucideLayers,
  Layers3 as LucideLayers3,
  Layout as LucideLayout,
  LayoutDashboard as LucideLayoutDashboard,
  LayoutGrid as LucideLayoutGrid,
  LayoutTemplate as LucideLayoutTemplate,
  Leaf as LucideLeaf,
  Lightbulb as LucideLightbulb,
  Link as LucideLink,
  Link2 as LucideLink2,
  Link2Off as LucideLink2Off,
  List as LucideList,
  ListChecks as LucideListChecks,
  ListFilter as LucideListFilter,
  ListOrdered as LucideListOrdered,
  ListPlus as LucideListPlus,
  ListTree as LucideListTree,
  Loader as LucideLoader,
  Loader2 as LucideLoader2,
  LoaderCircle as LucideLoaderCircle,
  LocateFixed as LucideLocateFixed,
  Lock as LucideLock,
  LockKeyhole as LucideLockKeyhole,
  LogIn as LucideLogIn,
  LogOut as LucideLogOut,
  Luggage as LucideLuggage,
  Mail as LucideMail,
  MailPlus as LucideMailPlus,
  Map as LucideMap,
  MapPin as LucideMapPin,
  MapPinned as LucideMapPinned,
  Maximize as LucideMaximize,
  Megaphone as LucideMegaphone,
  Menu as LucideMenu,
  MessageCircle as LucideMessageCircle,
  MessageSquare as LucideMessageSquare,
  MessageSquareHeart as LucideMessageSquareHeart,
  MessageSquareText as LucideMessageSquareText,
  MessagesSquare as LucideMessagesSquare,
  Mic as LucideMic,
  MicOff as LucideMicOff,
  Minimize as LucideMinimize,
  Minus as LucideMinus,
  Monitor as LucideMonitor,
  Moon as LucideMoon,
  MoreHorizontal as LucideMoreHorizontal,
  MoreVertical as LucideMoreVertical,
  Mountain as LucideMountain,
  MousePointerClick as LucideMousePointerClick,
  Navigation as LucideNavigation,
  Network as LucideNetwork,
  NotebookPen as LucideNotebookPen,
  Outdent as LucideOutdent,
  Package as LucidePackage,
  PackageCheck as LucidePackageCheck,
  PackagePlus as LucidePackagePlus,
  Palette as LucidePalette,
  PanelBottom as LucidePanelBottom,
  PanelLeftClose as LucidePanelLeftClose,
  PanelLeftOpen as LucidePanelLeftOpen,
  PanelTop as LucidePanelTop,
  PanelsTopLeft as LucidePanelsTopLeft,
  Paperclip as LucidePaperclip,
  Pause as LucidePause,
  PauseCircle as LucidePauseCircle,
  PenTool as LucidePenTool,
  Pencil as LucidePencil,
  PencilLine as LucidePencilLine,
  Percent as LucidePercent,
  Phone as LucidePhone,
  PhoneCall as LucidePhoneCall,
  PhoneOff as LucidePhoneOff,
  PieChart as LucidePieChart,
  Pill as LucidePill,
  Plane as LucidePlane,
  PlaneTakeoff as LucidePlaneTakeoff,
  Play as LucidePlay,
  PlayCircle as LucidePlayCircle,
  Plug as LucidePlug,
  Plus as LucidePlus,
  PlusCircle as LucidePlusCircle,
  Power as LucidePower,
  PowerOff as LucidePowerOff,
  QrCode as LucideQrCode,
  Radar as LucideRadar,
  Radio as LucideRadio,
  Receipt as LucideReceipt,
  ReceiptText as LucideReceiptText,
  Recycle as LucideRecycle,
  Redo2 as LucideRedo2,
  RefreshCcw as LucideRefreshCcw,
  RefreshCw as LucideRefreshCw,
  RemoveFormatting as LucideRemoveFormatting,
  Reply as LucideReply,
  RotateCcw as LucideRotateCcw,
  RotateCw as LucideRotateCw,
  Route as LucideRoute,
  Save as LucideSave,
  Scale as LucideScale,
  ScaleIcon as LucideScaleIcon,
  School as LucideSchool,
  ScrollText as LucideScrollText,
  Search as LucideSearch,
  Send as LucideSend,
  SendHorizonal as LucideSendHorizonal,
  Server as LucideServer,
  Settings as LucideSettings,
  Settings2 as LucideSettings2,
  Share2 as LucideShare2,
  Shield as LucideShield,
  ShieldAlert as LucideShieldAlert,
  ShieldCheck as LucideShieldCheck,
  ShieldOff as LucideShieldOff,
  ShieldQuestion as LucideShieldQuestion,
  ShoppingBag as LucideShoppingBag,
  Sliders as LucideSliders,
  SlidersHorizontal as LucideSlidersHorizontal,
  Smartphone as LucideSmartphone,
  Smile as LucideSmile,
  Space as LucideSpace,
  Sparkles as LucideSparkles,
  Square as LucideSquare,
  Stamp as LucideStamp,
  Star as LucideStar,
  Stethoscope as LucideStethoscope,
  StickyNote as LucideStickyNote,
  Strikethrough as LucideStrikethrough,
  Sun as LucideSun,
  Sunrise as LucideSunrise,
  Sunset as LucideSunset,
  Table as LucideTable,
  Tablet as LucideTablet,
  Tag as LucideTag,
  Tags as LucideTags,
  Target as LucideTarget,
  ThumbsDown as LucideThumbsDown,
  ThumbsUp as LucideThumbsUp,
  Ticket as LucideTicket,
  TicketPercent as LucideTicketPercent,
  Timer as LucideTimer,
  ToggleLeft as LucideToggleLeft,
  ToggleRight as LucideToggleRight,
  Train as LucideTrain,
  Trash2 as LucideTrash2,
  TrendingDown as LucideTrendingDown,
  TrendingUp as LucideTrendingUp,
  Trophy as LucideTrophy,
  Truck as LucideTruck,
  Twitter as LucideTwitter,
  Type as LucideType,
  Underline as LucideUnderline,
  Undo2 as LucideUndo2,
  Unlock as LucideUnlock,
  Upload as LucideUpload,
  UploadCloud as LucideUploadCloud,
  User as LucideUser,
  UserCheck as LucideUserCheck,
  UserCircle as LucideUserCircle,
  UserCircle2 as LucideUserCircle2,
  UserIcon as LucideUserIcon,
  UserPlus as LucideUserPlus,
  UserRound as LucideUserRound,
  UserX as LucideUserX,
  Users as LucideUsers,
  UsersRound as LucideUsersRound,
  Utensils as LucideUtensils,
  Video as LucideVideo,
  Wallet as LucideWallet,
  WalletCards as LucideWalletCards,
  Wand2 as LucideWand2,
  Waves as LucideWaves,
  Webhook as LucideWebhook,
  Workflow as LucideWorkflow,
  X as LucideX,
  XCircle as LucideXCircle,
  Zap as LucideZap,
  ZoomIn as LucideZoomIn,
  ZoomOut as LucideZoomOut,
} from 'lucide-react/dist/esm/lucide-react.js';
import AccountBookOutlined from '@ant-design/icons-svg/es/asn/AccountBookOutlined.js';
import AimOutlined from '@ant-design/icons-svg/es/asn/AimOutlined.js';
import AlignCenterOutlined from '@ant-design/icons-svg/es/asn/AlignCenterOutlined.js';
import AlignLeftOutlined from '@ant-design/icons-svg/es/asn/AlignLeftOutlined.js';
import AlignRightOutlined from '@ant-design/icons-svg/es/asn/AlignRightOutlined.js';
import ApartmentOutlined from '@ant-design/icons-svg/es/asn/ApartmentOutlined.js';
import ApiOutlined from '@ant-design/icons-svg/es/asn/ApiOutlined.js';
import AppstoreAddOutlined from '@ant-design/icons-svg/es/asn/AppstoreAddOutlined.js';
import AppstoreOutlined from '@ant-design/icons-svg/es/asn/AppstoreOutlined.js';
import ArrowDownOutlined from '@ant-design/icons-svg/es/asn/ArrowDownOutlined.js';
import ArrowLeftOutlined from '@ant-design/icons-svg/es/asn/ArrowLeftOutlined.js';
import ArrowRightOutlined from '@ant-design/icons-svg/es/asn/ArrowRightOutlined.js';
import ArrowUpOutlined from '@ant-design/icons-svg/es/asn/ArrowUpOutlined.js';
import AudioMutedOutlined from '@ant-design/icons-svg/es/asn/AudioMutedOutlined.js';
import AudioOutlined from '@ant-design/icons-svg/es/asn/AudioOutlined.js';
import AuditOutlined from '@ant-design/icons-svg/es/asn/AuditOutlined.js';
import BankOutlined from '@ant-design/icons-svg/es/asn/BankOutlined.js';
import BarChartOutlined from '@ant-design/icons-svg/es/asn/BarChartOutlined.js';
import BellOutlined from '@ant-design/icons-svg/es/asn/BellOutlined.js';
import BgColorsOutlined from '@ant-design/icons-svg/es/asn/BgColorsOutlined.js';
import BlockOutlined from '@ant-design/icons-svg/es/asn/BlockOutlined.js';
import BoldOutlined from '@ant-design/icons-svg/es/asn/BoldOutlined.js';
import BookOutlined from '@ant-design/icons-svg/es/asn/BookOutlined.js';
import BorderOutlined from '@ant-design/icons-svg/es/asn/BorderOutlined.js';
import BranchesOutlined from '@ant-design/icons-svg/es/asn/BranchesOutlined.js';
import BulbOutlined from '@ant-design/icons-svg/es/asn/BulbOutlined.js';
import CalculatorOutlined from '@ant-design/icons-svg/es/asn/CalculatorOutlined.js';
import CalendarOutlined from '@ant-design/icons-svg/es/asn/CalendarOutlined.js';
import CameraOutlined from '@ant-design/icons-svg/es/asn/CameraOutlined.js';
import CarOutlined from '@ant-design/icons-svg/es/asn/CarOutlined.js';
import CaretRightOutlined from '@ant-design/icons-svg/es/asn/CaretRightOutlined.js';
import CheckCircleOutlined from '@ant-design/icons-svg/es/asn/CheckCircleOutlined.js';
import CheckOutlined from '@ant-design/icons-svg/es/asn/CheckOutlined.js';
import CheckSquareOutlined from '@ant-design/icons-svg/es/asn/CheckSquareOutlined.js';
import ClearOutlined from '@ant-design/icons-svg/es/asn/ClearOutlined.js';
import ClockCircleOutlined from '@ant-design/icons-svg/es/asn/ClockCircleOutlined.js';
import CloseCircleOutlined from '@ant-design/icons-svg/es/asn/CloseCircleOutlined.js';
import CloseOutlined from '@ant-design/icons-svg/es/asn/CloseOutlined.js';
import CloudOutlined from '@ant-design/icons-svg/es/asn/CloudOutlined.js';
import CodeOutlined from '@ant-design/icons-svg/es/asn/CodeOutlined.js';
import CompassOutlined from '@ant-design/icons-svg/es/asn/CompassOutlined.js';
import CompressOutlined from '@ant-design/icons-svg/es/asn/CompressOutlined.js';
import ContainerOutlined from '@ant-design/icons-svg/es/asn/ContainerOutlined.js';
import CopyOutlined from '@ant-design/icons-svg/es/asn/CopyOutlined.js';
import CreditCardOutlined from '@ant-design/icons-svg/es/asn/CreditCardOutlined.js';
import CrownOutlined from '@ant-design/icons-svg/es/asn/CrownOutlined.js';
import DatabaseOutlined from '@ant-design/icons-svg/es/asn/DatabaseOutlined.js';
import DeleteOutlined from '@ant-design/icons-svg/es/asn/DeleteOutlined.js';
import DesktopOutlined from '@ant-design/icons-svg/es/asn/DesktopOutlined.js';
import DisconnectOutlined from '@ant-design/icons-svg/es/asn/DisconnectOutlined.js';
import DislikeOutlined from '@ant-design/icons-svg/es/asn/DislikeOutlined.js';
import DollarOutlined from '@ant-design/icons-svg/es/asn/DollarOutlined.js';
import DownOutlined from '@ant-design/icons-svg/es/asn/DownOutlined.js';
import DownloadOutlined from '@ant-design/icons-svg/es/asn/DownloadOutlined.js';
import EditOutlined from '@ant-design/icons-svg/es/asn/EditOutlined.js';
import EllipsisOutlined from '@ant-design/icons-svg/es/asn/EllipsisOutlined.js';
import EnterOutlined from '@ant-design/icons-svg/es/asn/EnterOutlined.js';
import EnvironmentOutlined from '@ant-design/icons-svg/es/asn/EnvironmentOutlined.js';
import ExclamationCircleOutlined from '@ant-design/icons-svg/es/asn/ExclamationCircleOutlined.js';
import ExportOutlined from '@ant-design/icons-svg/es/asn/ExportOutlined.js';
import EyeInvisibleOutlined from '@ant-design/icons-svg/es/asn/EyeInvisibleOutlined.js';
import EyeOutlined from '@ant-design/icons-svg/es/asn/EyeOutlined.js';
import FacebookOutlined from '@ant-design/icons-svg/es/asn/FacebookOutlined.js';
import FallOutlined from '@ant-design/icons-svg/es/asn/FallOutlined.js';
import FieldNumberOutlined from '@ant-design/icons-svg/es/asn/FieldNumberOutlined.js';
import FileDoneOutlined from '@ant-design/icons-svg/es/asn/FileDoneOutlined.js';
import FileExcelOutlined from '@ant-design/icons-svg/es/asn/FileExcelOutlined.js';
import FileImageOutlined from '@ant-design/icons-svg/es/asn/FileImageOutlined.js';
import FileTextOutlined from '@ant-design/icons-svg/es/asn/FileTextOutlined.js';
import FilterOutlined from '@ant-design/icons-svg/es/asn/FilterOutlined.js';
import FireOutlined from '@ant-design/icons-svg/es/asn/FireOutlined.js';
import FlagOutlined from '@ant-design/icons-svg/es/asn/FlagOutlined.js';
import FolderAddOutlined from '@ant-design/icons-svg/es/asn/FolderAddOutlined.js';
import FolderOpenOutlined from '@ant-design/icons-svg/es/asn/FolderOpenOutlined.js';
import FolderOutlined from '@ant-design/icons-svg/es/asn/FolderOutlined.js';
import FontSizeOutlined from '@ant-design/icons-svg/es/asn/FontSizeOutlined.js';
import FormOutlined from '@ant-design/icons-svg/es/asn/FormOutlined.js';
import FormatPainterOutlined from '@ant-design/icons-svg/es/asn/FormatPainterOutlined.js';
import ForwardOutlined from '@ant-design/icons-svg/es/asn/ForwardOutlined.js';
import FullscreenExitOutlined from '@ant-design/icons-svg/es/asn/FullscreenExitOutlined.js';
import FullscreenOutlined from '@ant-design/icons-svg/es/asn/FullscreenOutlined.js';
import GiftOutlined from '@ant-design/icons-svg/es/asn/GiftOutlined.js';
import GithubOutlined from '@ant-design/icons-svg/es/asn/GithubOutlined.js';
import GlobalOutlined from '@ant-design/icons-svg/es/asn/GlobalOutlined.js';
import HddOutlined from '@ant-design/icons-svg/es/asn/HddOutlined.js';
import HeartOutlined from '@ant-design/icons-svg/es/asn/HeartOutlined.js';
import HighlightOutlined from '@ant-design/icons-svg/es/asn/HighlightOutlined.js';
import HistoryOutlined from '@ant-design/icons-svg/es/asn/HistoryOutlined.js';
import HolderOutlined from '@ant-design/icons-svg/es/asn/HolderOutlined.js';
import HomeOutlined from '@ant-design/icons-svg/es/asn/HomeOutlined.js';
import HourglassOutlined from '@ant-design/icons-svg/es/asn/HourglassOutlined.js';
import ImportOutlined from '@ant-design/icons-svg/es/asn/ImportOutlined.js';
import InboxOutlined from '@ant-design/icons-svg/es/asn/InboxOutlined.js';
import InfoCircleOutlined from '@ant-design/icons-svg/es/asn/InfoCircleOutlined.js';
import InfoOutlined from '@ant-design/icons-svg/es/asn/InfoOutlined.js';
import InsertRowRightOutlined from '@ant-design/icons-svg/es/asn/InsertRowRightOutlined.js';
import ItalicOutlined from '@ant-design/icons-svg/es/asn/ItalicOutlined.js';
import KeyOutlined from '@ant-design/icons-svg/es/asn/KeyOutlined.js';
import LayoutOutlined from '@ant-design/icons-svg/es/asn/LayoutOutlined.js';
import LeftOutlined from '@ant-design/icons-svg/es/asn/LeftOutlined.js';
import LikeOutlined from '@ant-design/icons-svg/es/asn/LikeOutlined.js';
import LineChartOutlined from '@ant-design/icons-svg/es/asn/LineChartOutlined.js';
import LinkOutlined from '@ant-design/icons-svg/es/asn/LinkOutlined.js';
import LoadingOutlined from '@ant-design/icons-svg/es/asn/LoadingOutlined.js';
import LockOutlined from '@ant-design/icons-svg/es/asn/LockOutlined.js';
import LoginOutlined from '@ant-design/icons-svg/es/asn/LoginOutlined.js';
import LogoutOutlined from '@ant-design/icons-svg/es/asn/LogoutOutlined.js';
import MacCommandOutlined from '@ant-design/icons-svg/es/asn/MacCommandOutlined.js';
import MailOutlined from '@ant-design/icons-svg/es/asn/MailOutlined.js';
import MedicineBoxOutlined from '@ant-design/icons-svg/es/asn/MedicineBoxOutlined.js';
import MenuFoldOutlined from '@ant-design/icons-svg/es/asn/MenuFoldOutlined.js';
import MenuOutlined from '@ant-design/icons-svg/es/asn/MenuOutlined.js';
import MenuUnfoldOutlined from '@ant-design/icons-svg/es/asn/MenuUnfoldOutlined.js';
import MergeOutlined from '@ant-design/icons-svg/es/asn/MergeOutlined.js';
import MessageOutlined from '@ant-design/icons-svg/es/asn/MessageOutlined.js';
import MinusOutlined from '@ant-design/icons-svg/es/asn/MinusOutlined.js';
import MobileOutlined from '@ant-design/icons-svg/es/asn/MobileOutlined.js';
import MonitorOutlined from '@ant-design/icons-svg/es/asn/MonitorOutlined.js';
import MoonOutlined from '@ant-design/icons-svg/es/asn/MoonOutlined.js';
import MoreOutlined from '@ant-design/icons-svg/es/asn/MoreOutlined.js';
import MutedOutlined from '@ant-design/icons-svg/es/asn/MutedOutlined.js';
import NodeIndexOutlined from '@ant-design/icons-svg/es/asn/NodeIndexOutlined.js';
import NotificationOutlined from '@ant-design/icons-svg/es/asn/NotificationOutlined.js';
import NumberOutlined from '@ant-design/icons-svg/es/asn/NumberOutlined.js';
import OrderedListOutlined from '@ant-design/icons-svg/es/asn/OrderedListOutlined.js';
import PaperClipOutlined from '@ant-design/icons-svg/es/asn/PaperClipOutlined.js';
import PartitionOutlined from '@ant-design/icons-svg/es/asn/PartitionOutlined.js';
import PauseCircleOutlined from '@ant-design/icons-svg/es/asn/PauseCircleOutlined.js';
import PauseOutlined from '@ant-design/icons-svg/es/asn/PauseOutlined.js';
import PercentageOutlined from '@ant-design/icons-svg/es/asn/PercentageOutlined.js';
import PhoneOutlined from '@ant-design/icons-svg/es/asn/PhoneOutlined.js';
import PictureOutlined from '@ant-design/icons-svg/es/asn/PictureOutlined.js';
import PieChartOutlined from '@ant-design/icons-svg/es/asn/PieChartOutlined.js';
import PlayCircleOutlined from '@ant-design/icons-svg/es/asn/PlayCircleOutlined.js';
import PlusCircleOutlined from '@ant-design/icons-svg/es/asn/PlusCircleOutlined.js';
import PlusOutlined from '@ant-design/icons-svg/es/asn/PlusOutlined.js';
import PoweroffOutlined from '@ant-design/icons-svg/es/asn/PoweroffOutlined.js';
import ProductOutlined from '@ant-design/icons-svg/es/asn/ProductOutlined.js';
import ProfileOutlined from '@ant-design/icons-svg/es/asn/ProfileOutlined.js';
import ProjectOutlined from '@ant-design/icons-svg/es/asn/ProjectOutlined.js';
import QrcodeOutlined from '@ant-design/icons-svg/es/asn/QrcodeOutlined.js';
import QuestionCircleOutlined from '@ant-design/icons-svg/es/asn/QuestionCircleOutlined.js';
import RadarChartOutlined from '@ant-design/icons-svg/es/asn/RadarChartOutlined.js';
import ReadOutlined from '@ant-design/icons-svg/es/asn/ReadOutlined.js';
import RedoOutlined from '@ant-design/icons-svg/es/asn/RedoOutlined.js';
import ReloadOutlined from '@ant-design/icons-svg/es/asn/ReloadOutlined.js';
import RestOutlined from '@ant-design/icons-svg/es/asn/RestOutlined.js';
import RetweetOutlined from '@ant-design/icons-svg/es/asn/RetweetOutlined.js';
import RightCircleOutlined from '@ant-design/icons-svg/es/asn/RightCircleOutlined.js';
import RightOutlined from '@ant-design/icons-svg/es/asn/RightOutlined.js';
import RiseOutlined from '@ant-design/icons-svg/es/asn/RiseOutlined.js';
import RobotOutlined from '@ant-design/icons-svg/es/asn/RobotOutlined.js';
import RocketOutlined from '@ant-design/icons-svg/es/asn/RocketOutlined.js';
import RollbackOutlined from '@ant-design/icons-svg/es/asn/RollbackOutlined.js';
import RotateLeftOutlined from '@ant-design/icons-svg/es/asn/RotateLeftOutlined.js';
import RotateRightOutlined from '@ant-design/icons-svg/es/asn/RotateRightOutlined.js';
import SafetyCertificateOutlined from '@ant-design/icons-svg/es/asn/SafetyCertificateOutlined.js';
import SafetyOutlined from '@ant-design/icons-svg/es/asn/SafetyOutlined.js';
import SaveOutlined from '@ant-design/icons-svg/es/asn/SaveOutlined.js';
import ScheduleOutlined from '@ant-design/icons-svg/es/asn/ScheduleOutlined.js';
import SearchOutlined from '@ant-design/icons-svg/es/asn/SearchOutlined.js';
import SecurityScanOutlined from '@ant-design/icons-svg/es/asn/SecurityScanOutlined.js';
import SelectOutlined from '@ant-design/icons-svg/es/asn/SelectOutlined.js';
import SendOutlined from '@ant-design/icons-svg/es/asn/SendOutlined.js';
import SettingOutlined from '@ant-design/icons-svg/es/asn/SettingOutlined.js';
import ShareAltOutlined from '@ant-design/icons-svg/es/asn/ShareAltOutlined.js';
import ShopOutlined from '@ant-design/icons-svg/es/asn/ShopOutlined.js';
import ShoppingOutlined from '@ant-design/icons-svg/es/asn/ShoppingOutlined.js';
import SignatureOutlined from '@ant-design/icons-svg/es/asn/SignatureOutlined.js';
import SlidersOutlined from '@ant-design/icons-svg/es/asn/SlidersOutlined.js';
import SmileOutlined from '@ant-design/icons-svg/es/asn/SmileOutlined.js';
import SnippetsOutlined from '@ant-design/icons-svg/es/asn/SnippetsOutlined.js';
import StarOutlined from '@ant-design/icons-svg/es/asn/StarOutlined.js';
import StopOutlined from '@ant-design/icons-svg/es/asn/StopOutlined.js';
import StrikethroughOutlined from '@ant-design/icons-svg/es/asn/StrikethroughOutlined.js';
import SunOutlined from '@ant-design/icons-svg/es/asn/SunOutlined.js';
import SwapLeftOutlined from '@ant-design/icons-svg/es/asn/SwapLeftOutlined.js';
import SwapOutlined from '@ant-design/icons-svg/es/asn/SwapOutlined.js';
import SwitcherOutlined from '@ant-design/icons-svg/es/asn/SwitcherOutlined.js';
import TableOutlined from '@ant-design/icons-svg/es/asn/TableOutlined.js';
import TabletOutlined from '@ant-design/icons-svg/es/asn/TabletOutlined.js';
import TagOutlined from '@ant-design/icons-svg/es/asn/TagOutlined.js';
import TagsOutlined from '@ant-design/icons-svg/es/asn/TagsOutlined.js';
import TeamOutlined from '@ant-design/icons-svg/es/asn/TeamOutlined.js';
import ThunderboltOutlined from '@ant-design/icons-svg/es/asn/ThunderboltOutlined.js';
import TrophyOutlined from '@ant-design/icons-svg/es/asn/TrophyOutlined.js';
import TruckOutlined from '@ant-design/icons-svg/es/asn/TruckOutlined.js';
import TwitterOutlined from '@ant-design/icons-svg/es/asn/TwitterOutlined.js';
import UnderlineOutlined from '@ant-design/icons-svg/es/asn/UnderlineOutlined.js';
import UndoOutlined from '@ant-design/icons-svg/es/asn/UndoOutlined.js';
import UnlockOutlined from '@ant-design/icons-svg/es/asn/UnlockOutlined.js';
import UnorderedListOutlined from '@ant-design/icons-svg/es/asn/UnorderedListOutlined.js';
import UpOutlined from '@ant-design/icons-svg/es/asn/UpOutlined.js';
import UploadOutlined from '@ant-design/icons-svg/es/asn/UploadOutlined.js';
import UserAddOutlined from '@ant-design/icons-svg/es/asn/UserAddOutlined.js';
import UserDeleteOutlined from '@ant-design/icons-svg/es/asn/UserDeleteOutlined.js';
import UserOutlined from '@ant-design/icons-svg/es/asn/UserOutlined.js';
import UserSwitchOutlined from '@ant-design/icons-svg/es/asn/UserSwitchOutlined.js';
import VerticalAlignBottomOutlined from '@ant-design/icons-svg/es/asn/VerticalAlignBottomOutlined.js';
import VerticalAlignTopOutlined from '@ant-design/icons-svg/es/asn/VerticalAlignTopOutlined.js';
import VideoCameraOutlined from '@ant-design/icons-svg/es/asn/VideoCameraOutlined.js';
import WalletOutlined from '@ant-design/icons-svg/es/asn/WalletOutlined.js';
import WarningOutlined from '@ant-design/icons-svg/es/asn/WarningOutlined.js';
import WifiOutlined from '@ant-design/icons-svg/es/asn/WifiOutlined.js';
import ZoomInOutlined from '@ant-design/icons-svg/es/asn/ZoomInOutlined.js';
import ZoomOutOutlined from '@ant-design/icons-svg/es/asn/ZoomOutOutlined.js';

export const Activity = /* @__PURE__ */ createThemedIcon(LucideActivity, LineChartOutlined, 'Activity');
export const AlertCircle = /* @__PURE__ */ createThemedIcon(LucideAlertCircle, ExclamationCircleOutlined, 'AlertCircle');
export const AlertTriangle = /* @__PURE__ */ createThemedIcon(LucideAlertTriangle, WarningOutlined, 'AlertTriangle');
export const AlignCenter = /* @__PURE__ */ createThemedIcon(LucideAlignCenter, AlignCenterOutlined, 'AlignCenter');
export const AlignJustify = /* @__PURE__ */ createThemedIcon(LucideAlignJustify, MenuOutlined, 'AlignJustify');
export const AlignLeft = /* @__PURE__ */ createThemedIcon(LucideAlignLeft, AlignLeftOutlined, 'AlignLeft');
export const AlignRight = /* @__PURE__ */ createThemedIcon(LucideAlignRight, AlignRightOutlined, 'AlignRight');
export const Archive = /* @__PURE__ */ createThemedIcon(LucideArchive, ContainerOutlined, 'Archive');
export const ArchiveRestore = /* @__PURE__ */ createThemedIcon(LucideArchiveRestore, ImportOutlined, 'ArchiveRestore');
export const ArrowDown = /* @__PURE__ */ createThemedIcon(LucideArrowDown, ArrowDownOutlined, 'ArrowDown');
export const ArrowDownLeft = /* @__PURE__ */ createThemedIcon(LucideArrowDownLeft, SwapLeftOutlined, 'ArrowDownLeft');
export const ArrowDownToLine = /* @__PURE__ */ createThemedIcon(LucideArrowDownToLine, VerticalAlignBottomOutlined, 'ArrowDownToLine');
export const ArrowLeft = /* @__PURE__ */ createThemedIcon(LucideArrowLeft, ArrowLeftOutlined, 'ArrowLeft');
export const ArrowRight = /* @__PURE__ */ createThemedIcon(LucideArrowRight, ArrowRightOutlined, 'ArrowRight');
export const ArrowRightCircle = /* @__PURE__ */ createThemedIcon(LucideArrowRightCircle, RightCircleOutlined, 'ArrowRightCircle');
export const ArrowRightLeft = /* @__PURE__ */ createThemedIcon(LucideArrowRightLeft, SwapOutlined, 'ArrowRightLeft');
export const ArrowUp = /* @__PURE__ */ createThemedIcon(LucideArrowUp, ArrowUpOutlined, 'ArrowUp');
export const ArrowUpDown = /* @__PURE__ */ createThemedIcon(LucideArrowUpDown, SwapOutlined, 'ArrowUpDown');
export const ArrowUpFromLine = /* @__PURE__ */ createThemedIcon(LucideArrowUpFromLine, VerticalAlignTopOutlined, 'ArrowUpFromLine');
export const ArrowUpRight = /* @__PURE__ */ createThemedIcon(LucideArrowUpRight, RiseOutlined, 'ArrowUpRight');
export const AtSign = /* @__PURE__ */ createThemedIcon(LucideAtSign, MailOutlined, 'AtSign');
export const Award = /* @__PURE__ */ createThemedIcon(LucideAward, TrophyOutlined, 'Award');
export const BadgeCheck = /* @__PURE__ */ createThemedIcon(LucideBadgeCheck, SafetyCertificateOutlined, 'BadgeCheck');
export const BadgePercent = /* @__PURE__ */ createThemedIcon(LucideBadgePercent, PercentageOutlined, 'BadgePercent');
export const Ban = /* @__PURE__ */ createThemedIcon(LucideBan, StopOutlined, 'Ban');
export const Banknote = /* @__PURE__ */ createThemedIcon(LucideBanknote, WalletOutlined, 'Banknote');
export const BarChart = /* @__PURE__ */ createThemedIcon(LucideBarChart, BarChartOutlined, 'BarChart');
export const BarChart3 = /* @__PURE__ */ createThemedIcon(LucideBarChart3, BarChartOutlined, 'BarChart3');
export const BedDouble = /* @__PURE__ */ createThemedIcon(LucideBedDouble, RestOutlined, 'BedDouble');
export const Bell = /* @__PURE__ */ createThemedIcon(LucideBell, BellOutlined, 'Bell');
export const BellOff = /* @__PURE__ */ createThemedIcon(LucideBellOff, MutedOutlined, 'BellOff');
export const Blocks = /* @__PURE__ */ createThemedIcon(LucideBlocks, BlockOutlined, 'Blocks');
export const Bold = /* @__PURE__ */ createThemedIcon(LucideBold, BoldOutlined, 'Bold');
export const Book = /* @__PURE__ */ createThemedIcon(LucideBook, BookOutlined, 'Book');
export const BookOpen = /* @__PURE__ */ createThemedIcon(LucideBookOpen, ReadOutlined, 'BookOpen');
export const Bookmark = /* @__PURE__ */ createThemedIcon(LucideBookmark, BookOutlined, 'Bookmark');
export const BookmarkPlus = /* @__PURE__ */ createThemedIcon(LucideBookmarkPlus, BookOutlined, 'BookmarkPlus');
export const Bot = /* @__PURE__ */ createThemedIcon(LucideBot, RobotOutlined, 'Bot');
export const Box = /* @__PURE__ */ createThemedIcon(LucideBox, ContainerOutlined, 'Box');
export const Boxes = /* @__PURE__ */ createThemedIcon(LucideBoxes, ProductOutlined, 'Boxes');
export const Brain = /* @__PURE__ */ createThemedIcon(LucideBrain, BulbOutlined, 'Brain');
export const Briefcase = /* @__PURE__ */ createThemedIcon(LucideBriefcase, ProjectOutlined, 'Briefcase');
export const BriefcaseBusiness = /* @__PURE__ */ createThemedIcon(LucideBriefcaseBusiness, ProjectOutlined, 'BriefcaseBusiness');
export const Building = /* @__PURE__ */ createThemedIcon(LucideBuilding, BankOutlined, 'Building');
export const Building2 = /* @__PURE__ */ createThemedIcon(LucideBuilding2, BankOutlined, 'Building2');
export const Bus = /* @__PURE__ */ createThemedIcon(LucideBus, CarOutlined, 'Bus');
export const Calculator = /* @__PURE__ */ createThemedIcon(LucideCalculator, CalculatorOutlined, 'Calculator');
export const Calendar = /* @__PURE__ */ createThemedIcon(LucideCalendar, CalendarOutlined, 'Calendar');
export const CalendarCheck = /* @__PURE__ */ createThemedIcon(LucideCalendarCheck, CalendarOutlined, 'CalendarCheck');
export const CalendarClock = /* @__PURE__ */ createThemedIcon(LucideCalendarClock, ScheduleOutlined, 'CalendarClock');
export const CalendarDays = /* @__PURE__ */ createThemedIcon(LucideCalendarDays, CalendarOutlined, 'CalendarDays');
export const CalendarIcon = /* @__PURE__ */ createThemedIcon(LucideCalendarIcon, CalendarOutlined, 'CalendarIcon');
export const CalendarOff = /* @__PURE__ */ createThemedIcon(LucideCalendarOff, CalendarOutlined, 'CalendarOff');
export const CalendarPlus = /* @__PURE__ */ createThemedIcon(LucideCalendarPlus, CalendarOutlined, 'CalendarPlus');
export const CalendarRange = /* @__PURE__ */ createThemedIcon(LucideCalendarRange, CalendarOutlined, 'CalendarRange');
export const Camera = /* @__PURE__ */ createThemedIcon(LucideCamera, CameraOutlined, 'Camera');
export const Car = /* @__PURE__ */ createThemedIcon(LucideCar, CarOutlined, 'Car');
export const Check = /* @__PURE__ */ createThemedIcon(LucideCheck, CheckOutlined, 'Check');
export const CheckCheck = /* @__PURE__ */ createThemedIcon(LucideCheckCheck, CheckOutlined, 'CheckCheck');
export const CheckCircle = /* @__PURE__ */ createThemedIcon(LucideCheckCircle, CheckCircleOutlined, 'CheckCircle');
export const CheckCircle2 = /* @__PURE__ */ createThemedIcon(LucideCheckCircle2, CheckCircleOutlined, 'CheckCircle2');
export const CheckSquare = /* @__PURE__ */ createThemedIcon(LucideCheckSquare, CheckSquareOutlined, 'CheckSquare');
export const ChevronDown = /* @__PURE__ */ createThemedIcon(LucideChevronDown, DownOutlined, 'ChevronDown');
export const ChevronLeft = /* @__PURE__ */ createThemedIcon(LucideChevronLeft, LeftOutlined, 'ChevronLeft');
export const ChevronRight = /* @__PURE__ */ createThemedIcon(LucideChevronRight, RightOutlined, 'ChevronRight');
export const ChevronUp = /* @__PURE__ */ createThemedIcon(LucideChevronUp, UpOutlined, 'ChevronUp');
export const Circle = /* @__PURE__ */ createThemedIcon(LucideCircle, InfoCircleOutlined, 'Circle');
export const CircleCheck = /* @__PURE__ */ createThemedIcon(LucideCircleCheck, CheckCircleOutlined, 'CircleCheck');
export const CircleHelp = /* @__PURE__ */ createThemedIcon(LucideCircleHelp, QuestionCircleOutlined, 'CircleHelp');
export const Clipboard = /* @__PURE__ */ createThemedIcon(LucideClipboard, SnippetsOutlined, 'Clipboard');
export const ClipboardCheck = /* @__PURE__ */ createThemedIcon(LucideClipboardCheck, CheckCircleOutlined, 'ClipboardCheck');
export const ClipboardList = /* @__PURE__ */ createThemedIcon(LucideClipboardList, ProfileOutlined, 'ClipboardList');
export const Clock = /* @__PURE__ */ createThemedIcon(LucideClock, ClockCircleOutlined, 'Clock');
export const Clock3 = /* @__PURE__ */ createThemedIcon(LucideClock3, ClockCircleOutlined, 'Clock3');
export const Cloud = /* @__PURE__ */ createThemedIcon(LucideCloud, CloudOutlined, 'Cloud');
export const CloudLightning = /* @__PURE__ */ createThemedIcon(LucideCloudLightning, ThunderboltOutlined, 'CloudLightning');
export const Code = /* @__PURE__ */ createThemedIcon(LucideCode, CodeOutlined, 'Code');
export const Code2 = /* @__PURE__ */ createThemedIcon(LucideCode2, CodeOutlined, 'Code2');
export const Coins = /* @__PURE__ */ createThemedIcon(LucideCoins, WalletOutlined, 'Coins');
export const Columns = /* @__PURE__ */ createThemedIcon(LucideColumns, InsertRowRightOutlined, 'Columns');
export const Compass = /* @__PURE__ */ createThemedIcon(LucideCompass, CompassOutlined, 'Compass');
export const Construction = /* @__PURE__ */ createThemedIcon(LucideConstruction, WarningOutlined, 'Construction');
export const Copy = /* @__PURE__ */ createThemedIcon(LucideCopy, CopyOutlined, 'Copy');
export const CopyPlus = /* @__PURE__ */ createThemedIcon(LucideCopyPlus, CopyOutlined, 'CopyPlus');
export const CornerDownLeft = /* @__PURE__ */ createThemedIcon(LucideCornerDownLeft, EnterOutlined, 'CornerDownLeft');
export const CornerUpLeft = /* @__PURE__ */ createThemedIcon(LucideCornerUpLeft, RollbackOutlined, 'CornerUpLeft');
export const Cpu = /* @__PURE__ */ createThemedIcon(LucideCpu, DesktopOutlined, 'Cpu');
export const CreditCard = /* @__PURE__ */ createThemedIcon(LucideCreditCard, CreditCardOutlined, 'CreditCard');
export const Crosshair = /* @__PURE__ */ createThemedIcon(LucideCrosshair, AimOutlined, 'Crosshair');
export const Crown = /* @__PURE__ */ createThemedIcon(LucideCrown, CrownOutlined, 'Crown');
export const Database = /* @__PURE__ */ createThemedIcon(LucideDatabase, DatabaseOutlined, 'Database');
export const DollarSign = /* @__PURE__ */ createThemedIcon(LucideDollarSign, DollarOutlined, 'DollarSign');
export const Download = /* @__PURE__ */ createThemedIcon(LucideDownload, DownloadOutlined, 'Download');
export const Edit = /* @__PURE__ */ createThemedIcon(LucideEdit, EditOutlined, 'Edit');
export const Edit2 = /* @__PURE__ */ createThemedIcon(LucideEdit2, EditOutlined, 'Edit2');
export const Edit3 = /* @__PURE__ */ createThemedIcon(LucideEdit3, EditOutlined, 'Edit3');
export const ExternalLink = /* @__PURE__ */ createThemedIcon(LucideExternalLink, ExportOutlined, 'ExternalLink');
export const Eye = /* @__PURE__ */ createThemedIcon(LucideEye, EyeOutlined, 'Eye');
export const EyeOff = /* @__PURE__ */ createThemedIcon(LucideEyeOff, EyeInvisibleOutlined, 'EyeOff');
export const Facebook = /* @__PURE__ */ createThemedIcon(LucideFacebook, FacebookOutlined, 'Facebook');
export const FileBarChart = /* @__PURE__ */ createThemedIcon(LucideFileBarChart, FileExcelOutlined, 'FileBarChart');
export const FileCheck = /* @__PURE__ */ createThemedIcon(LucideFileCheck, FileDoneOutlined, 'FileCheck');
export const FileCheck2 = /* @__PURE__ */ createThemedIcon(LucideFileCheck2, FileDoneOutlined, 'FileCheck2');
export const FileDigit = /* @__PURE__ */ createThemedIcon(LucideFileDigit, FieldNumberOutlined, 'FileDigit');
export const FileDown = /* @__PURE__ */ createThemedIcon(LucideFileDown, DownloadOutlined, 'FileDown');
export const FileEdit = /* @__PURE__ */ createThemedIcon(LucideFileEdit, FormOutlined, 'FileEdit');
export const FileImage = /* @__PURE__ */ createThemedIcon(LucideFileImage, FileImageOutlined, 'FileImage');
export const FileInput = /* @__PURE__ */ createThemedIcon(LucideFileInput, ExportOutlined, 'FileInput');
export const FileJson = /* @__PURE__ */ createThemedIcon(LucideFileJson, CodeOutlined, 'FileJson');
export const FileSignature = /* @__PURE__ */ createThemedIcon(LucideFileSignature, SignatureOutlined, 'FileSignature');
export const FileSpreadsheet = /* @__PURE__ */ createThemedIcon(LucideFileSpreadsheet, FileExcelOutlined, 'FileSpreadsheet');
export const FileStack = /* @__PURE__ */ createThemedIcon(LucideFileStack, SnippetsOutlined, 'FileStack');
export const FileText = /* @__PURE__ */ createThemedIcon(LucideFileText, FileTextOutlined, 'FileText');
export const FileUp = /* @__PURE__ */ createThemedIcon(LucideFileUp, UploadOutlined, 'FileUp');
export const Film = /* @__PURE__ */ createThemedIcon(LucideFilm, VideoCameraOutlined, 'Film');
export const Filter = /* @__PURE__ */ createThemedIcon(LucideFilter, FilterOutlined, 'Filter');
export const Flag = /* @__PURE__ */ createThemedIcon(LucideFlag, FlagOutlined, 'Flag');
export const Flame = /* @__PURE__ */ createThemedIcon(LucideFlame, FireOutlined, 'Flame');
export const Folder = /* @__PURE__ */ createThemedIcon(LucideFolder, FolderOutlined, 'Folder');
export const FolderKanban = /* @__PURE__ */ createThemedIcon(LucideFolderKanban, ProjectOutlined, 'FolderKanban');
export const FolderOpen = /* @__PURE__ */ createThemedIcon(LucideFolderOpen, FolderOpenOutlined, 'FolderOpen');
export const FolderPlus = /* @__PURE__ */ createThemedIcon(LucideFolderPlus, FolderAddOutlined, 'FolderPlus');
export const FolderTree = /* @__PURE__ */ createThemedIcon(LucideFolderTree, PartitionOutlined, 'FolderTree');
export const Forward = /* @__PURE__ */ createThemedIcon(LucideForward, ForwardOutlined, 'Forward');
export const Gift = /* @__PURE__ */ createThemedIcon(LucideGift, GiftOutlined, 'Gift');
export const GitBranch = /* @__PURE__ */ createThemedIcon(LucideGitBranch, BranchesOutlined, 'GitBranch');
export const GitMerge = /* @__PURE__ */ createThemedIcon(LucideGitMerge, MergeOutlined, 'GitMerge');
export const Github = /* @__PURE__ */ createThemedIcon(LucideGithub, GithubOutlined, 'Github');
export const Globe = /* @__PURE__ */ createThemedIcon(LucideGlobe, GlobalOutlined, 'Globe');
export const Globe2 = /* @__PURE__ */ createThemedIcon(LucideGlobe2, GlobalOutlined, 'Globe2');
export const GraduationCap = /* @__PURE__ */ createThemedIcon(LucideGraduationCap, BankOutlined, 'GraduationCap');
export const Grid = /* @__PURE__ */ createThemedIcon(LucideGrid, AppstoreOutlined, 'Grid');
export const Grid3X3 = /* @__PURE__ */ createThemedIcon(LucideGrid3X3, AppstoreOutlined, 'Grid3X3');
export const Grid3x3 = /* @__PURE__ */ createThemedIcon(LucideGrid3x3, AppstoreOutlined, 'Grid3x3');
export const GripVertical = /* @__PURE__ */ createThemedIcon(LucideGripVertical, HolderOutlined, 'GripVertical');
export const HandCoins = /* @__PURE__ */ createThemedIcon(LucideHandCoins, WalletOutlined, 'HandCoins');
export const Handshake = /* @__PURE__ */ createThemedIcon(LucideHandshake, TeamOutlined, 'Handshake');
export const Hash = /* @__PURE__ */ createThemedIcon(LucideHash, NumberOutlined, 'Hash');
export const Heading = /* @__PURE__ */ createThemedIcon(LucideHeading, FontSizeOutlined, 'Heading');
export const Heart = /* @__PURE__ */ createThemedIcon(LucideHeart, HeartOutlined, 'Heart');
export const HeartHandshake = /* @__PURE__ */ createThemedIcon(LucideHeartHandshake, HeartOutlined, 'HeartHandshake');
export const HeartPulse = /* @__PURE__ */ createThemedIcon(LucideHeartPulse, LineChartOutlined, 'HeartPulse');
export const HelpCircle = /* @__PURE__ */ createThemedIcon(LucideHelpCircle, QuestionCircleOutlined, 'HelpCircle');
export const History = /* @__PURE__ */ createThemedIcon(LucideHistory, HistoryOutlined, 'History');
export const Home = /* @__PURE__ */ createThemedIcon(LucideHome, HomeOutlined, 'Home');
export const Hotel = /* @__PURE__ */ createThemedIcon(LucideHotel, BankOutlined, 'Hotel');
export const Hourglass = /* @__PURE__ */ createThemedIcon(LucideHourglass, HourglassOutlined, 'Hourglass');
export const Image = /* @__PURE__ */ createThemedIcon(LucideImage, PictureOutlined, 'Image');
export const ImagePlus = /* @__PURE__ */ createThemedIcon(LucideImagePlus, PictureOutlined, 'ImagePlus');
export const Import = /* @__PURE__ */ createThemedIcon(LucideImport, ImportOutlined, 'Import');
export const Inbox = /* @__PURE__ */ createThemedIcon(LucideInbox, InboxOutlined, 'Inbox');
export const Indent = /* @__PURE__ */ createThemedIcon(LucideIndent, MenuUnfoldOutlined, 'Indent');
export const IndianRupee = /* @__PURE__ */ createThemedIcon(LucideIndianRupee, WalletOutlined, 'IndianRupee');
export const Info = /* @__PURE__ */ createThemedIcon(LucideInfo, InfoOutlined, 'Info');
export const Italic = /* @__PURE__ */ createThemedIcon(LucideItalic, ItalicOutlined, 'Italic');
export const Key = /* @__PURE__ */ createThemedIcon(LucideKey, KeyOutlined, 'Key');
export const KeyRound = /* @__PURE__ */ createThemedIcon(LucideKeyRound, KeyOutlined, 'KeyRound');
export const Keyboard = /* @__PURE__ */ createThemedIcon(LucideKeyboard, MacCommandOutlined, 'Keyboard');
export const Landmark = /* @__PURE__ */ createThemedIcon(LucideLandmark, BankOutlined, 'Landmark');
export const Layers = /* @__PURE__ */ createThemedIcon(LucideLayers, BlockOutlined, 'Layers');
export const Layers3 = /* @__PURE__ */ createThemedIcon(LucideLayers3, BlockOutlined, 'Layers3');
export const Layout = /* @__PURE__ */ createThemedIcon(LucideLayout, LayoutOutlined, 'Layout');
export const LayoutDashboard = /* @__PURE__ */ createThemedIcon(LucideLayoutDashboard, AppstoreOutlined, 'LayoutDashboard');
export const LayoutGrid = /* @__PURE__ */ createThemedIcon(LucideLayoutGrid, AppstoreOutlined, 'LayoutGrid');
export const LayoutTemplate = /* @__PURE__ */ createThemedIcon(LucideLayoutTemplate, LayoutOutlined, 'LayoutTemplate');
export const Leaf = /* @__PURE__ */ createThemedIcon(LucideLeaf, BgColorsOutlined, 'Leaf');
export const Lightbulb = /* @__PURE__ */ createThemedIcon(LucideLightbulb, BulbOutlined, 'Lightbulb');
export const Link = /* @__PURE__ */ createThemedIcon(LucideLink, LinkOutlined, 'Link');
export const Link2 = /* @__PURE__ */ createThemedIcon(LucideLink2, LinkOutlined, 'Link2');
export const Link2Off = /* @__PURE__ */ createThemedIcon(LucideLink2Off, DisconnectOutlined, 'Link2Off');
export const List = /* @__PURE__ */ createThemedIcon(LucideList, UnorderedListOutlined, 'List');
export const ListChecks = /* @__PURE__ */ createThemedIcon(LucideListChecks, CheckSquareOutlined, 'ListChecks');
export const ListFilter = /* @__PURE__ */ createThemedIcon(LucideListFilter, FilterOutlined, 'ListFilter');
export const ListOrdered = /* @__PURE__ */ createThemedIcon(LucideListOrdered, OrderedListOutlined, 'ListOrdered');
export const ListPlus = /* @__PURE__ */ createThemedIcon(LucideListPlus, AppstoreAddOutlined, 'ListPlus');
export const ListTree = /* @__PURE__ */ createThemedIcon(LucideListTree, ApartmentOutlined, 'ListTree');
export const Loader = /* @__PURE__ */ createThemedIcon(LucideLoader, LoadingOutlined, 'Loader');
export const Loader2 = /* @__PURE__ */ createThemedIcon(LucideLoader2, LoadingOutlined, 'Loader2');
export const LoaderCircle = /* @__PURE__ */ createThemedIcon(LucideLoaderCircle, LoadingOutlined, 'LoaderCircle');
export const LocateFixed = /* @__PURE__ */ createThemedIcon(LucideLocateFixed, AimOutlined, 'LocateFixed');
export const Lock = /* @__PURE__ */ createThemedIcon(LucideLock, LockOutlined, 'Lock');
export const LockKeyhole = /* @__PURE__ */ createThemedIcon(LucideLockKeyhole, LockOutlined, 'LockKeyhole');
export const LogIn = /* @__PURE__ */ createThemedIcon(LucideLogIn, LoginOutlined, 'LogIn');
export const LogOut = /* @__PURE__ */ createThemedIcon(LucideLogOut, LogoutOutlined, 'LogOut');
export const Luggage = /* @__PURE__ */ createThemedIcon(LucideLuggage, ShoppingOutlined, 'Luggage');
export const Mail = /* @__PURE__ */ createThemedIcon(LucideMail, MailOutlined, 'Mail');
export const MailPlus = /* @__PURE__ */ createThemedIcon(LucideMailPlus, MailOutlined, 'MailPlus');
export const Map = /* @__PURE__ */ createThemedIcon(LucideMap, EnvironmentOutlined, 'Map');
export const MapPin = /* @__PURE__ */ createThemedIcon(LucideMapPin, EnvironmentOutlined, 'MapPin');
export const MapPinned = /* @__PURE__ */ createThemedIcon(LucideMapPinned, EnvironmentOutlined, 'MapPinned');
export const Maximize = /* @__PURE__ */ createThemedIcon(LucideMaximize, FullscreenOutlined, 'Maximize');
export const Megaphone = /* @__PURE__ */ createThemedIcon(LucideMegaphone, NotificationOutlined, 'Megaphone');
export const Menu = /* @__PURE__ */ createThemedIcon(LucideMenu, MenuOutlined, 'Menu');
export const MessageCircle = /* @__PURE__ */ createThemedIcon(LucideMessageCircle, MessageOutlined, 'MessageCircle');
export const MessageSquare = /* @__PURE__ */ createThemedIcon(LucideMessageSquare, MessageOutlined, 'MessageSquare');
export const MessageSquareHeart = /* @__PURE__ */ createThemedIcon(LucideMessageSquareHeart, MessageOutlined, 'MessageSquareHeart');
export const MessageSquareText = /* @__PURE__ */ createThemedIcon(LucideMessageSquareText, MessageOutlined, 'MessageSquareText');
export const MessagesSquare = /* @__PURE__ */ createThemedIcon(LucideMessagesSquare, MessageOutlined, 'MessagesSquare');
export const Mic = /* @__PURE__ */ createThemedIcon(LucideMic, AudioOutlined, 'Mic');
export const MicOff = /* @__PURE__ */ createThemedIcon(LucideMicOff, AudioMutedOutlined, 'MicOff');
export const Minimize = /* @__PURE__ */ createThemedIcon(LucideMinimize, FullscreenExitOutlined, 'Minimize');
export const Minus = /* @__PURE__ */ createThemedIcon(LucideMinus, MinusOutlined, 'Minus');
export const Monitor = /* @__PURE__ */ createThemedIcon(LucideMonitor, MonitorOutlined, 'Monitor');
export const Moon = /* @__PURE__ */ createThemedIcon(LucideMoon, MoonOutlined, 'Moon');
export const MoreHorizontal = /* @__PURE__ */ createThemedIcon(LucideMoreHorizontal, EllipsisOutlined, 'MoreHorizontal');
export const MoreVertical = /* @__PURE__ */ createThemedIcon(LucideMoreVertical, MoreOutlined, 'MoreVertical');
export const Mountain = /* @__PURE__ */ createThemedIcon(LucideMountain, EnvironmentOutlined, 'Mountain');
export const MousePointerClick = /* @__PURE__ */ createThemedIcon(LucideMousePointerClick, SelectOutlined, 'MousePointerClick');
export const Navigation = /* @__PURE__ */ createThemedIcon(LucideNavigation, SendOutlined, 'Navigation');
export const Network = /* @__PURE__ */ createThemedIcon(LucideNetwork, PartitionOutlined, 'Network');
export const NotebookPen = /* @__PURE__ */ createThemedIcon(LucideNotebookPen, EditOutlined, 'NotebookPen');
export const Outdent = /* @__PURE__ */ createThemedIcon(LucideOutdent, MenuFoldOutlined, 'Outdent');
export const Package = /* @__PURE__ */ createThemedIcon(LucidePackage, ProductOutlined, 'Package');
export const PackageCheck = /* @__PURE__ */ createThemedIcon(LucidePackageCheck, CheckCircleOutlined, 'PackageCheck');
export const PackagePlus = /* @__PURE__ */ createThemedIcon(LucidePackagePlus, AppstoreAddOutlined, 'PackagePlus');
export const Palette = /* @__PURE__ */ createThemedIcon(LucidePalette, BgColorsOutlined, 'Palette');
export const PanelBottom = /* @__PURE__ */ createThemedIcon(LucidePanelBottom, LayoutOutlined, 'PanelBottom');
export const PanelLeftClose = /* @__PURE__ */ createThemedIcon(LucidePanelLeftClose, MenuFoldOutlined, 'PanelLeftClose');
export const PanelLeftOpen = /* @__PURE__ */ createThemedIcon(LucidePanelLeftOpen, MenuUnfoldOutlined, 'PanelLeftOpen');
export const PanelTop = /* @__PURE__ */ createThemedIcon(LucidePanelTop, LayoutOutlined, 'PanelTop');
export const PanelsTopLeft = /* @__PURE__ */ createThemedIcon(LucidePanelsTopLeft, LayoutOutlined, 'PanelsTopLeft');
export const Paperclip = /* @__PURE__ */ createThemedIcon(LucidePaperclip, PaperClipOutlined, 'Paperclip');
export const Pause = /* @__PURE__ */ createThemedIcon(LucidePause, PauseOutlined, 'Pause');
export const PauseCircle = /* @__PURE__ */ createThemedIcon(LucidePauseCircle, PauseCircleOutlined, 'PauseCircle');
export const PenTool = /* @__PURE__ */ createThemedIcon(LucidePenTool, HighlightOutlined, 'PenTool');
export const Pencil = /* @__PURE__ */ createThemedIcon(LucidePencil, EditOutlined, 'Pencil');
export const PencilLine = /* @__PURE__ */ createThemedIcon(LucidePencilLine, EditOutlined, 'PencilLine');
export const Percent = /* @__PURE__ */ createThemedIcon(LucidePercent, PercentageOutlined, 'Percent');
export const Phone = /* @__PURE__ */ createThemedIcon(LucidePhone, PhoneOutlined, 'Phone');
export const PhoneCall = /* @__PURE__ */ createThemedIcon(LucidePhoneCall, PhoneOutlined, 'PhoneCall');
export const PhoneOff = /* @__PURE__ */ createThemedIcon(LucidePhoneOff, MutedOutlined, 'PhoneOff');
export const PieChart = /* @__PURE__ */ createThemedIcon(LucidePieChart, PieChartOutlined, 'PieChart');
export const Pill = /* @__PURE__ */ createThemedIcon(LucidePill, MedicineBoxOutlined, 'Pill');
export const Plane = /* @__PURE__ */ createThemedIcon(LucidePlane, RocketOutlined, 'Plane');
export const PlaneTakeoff = /* @__PURE__ */ createThemedIcon(LucidePlaneTakeoff, RocketOutlined, 'PlaneTakeoff');
export const Play = /* @__PURE__ */ createThemedIcon(LucidePlay, CaretRightOutlined, 'Play');
export const PlayCircle = /* @__PURE__ */ createThemedIcon(LucidePlayCircle, PlayCircleOutlined, 'PlayCircle');
export const Plug = /* @__PURE__ */ createThemedIcon(LucidePlug, ApiOutlined, 'Plug');
export const Plus = /* @__PURE__ */ createThemedIcon(LucidePlus, PlusOutlined, 'Plus');
export const PlusCircle = /* @__PURE__ */ createThemedIcon(LucidePlusCircle, PlusCircleOutlined, 'PlusCircle');
export const Power = /* @__PURE__ */ createThemedIcon(LucidePower, PoweroffOutlined, 'Power');
export const PowerOff = /* @__PURE__ */ createThemedIcon(LucidePowerOff, PoweroffOutlined, 'PowerOff');
export const QrCode = /* @__PURE__ */ createThemedIcon(LucideQrCode, QrcodeOutlined, 'QrCode');
export const Radar = /* @__PURE__ */ createThemedIcon(LucideRadar, RadarChartOutlined, 'Radar');
export const Radio = /* @__PURE__ */ createThemedIcon(LucideRadio, WifiOutlined, 'Radio');
export const Receipt = /* @__PURE__ */ createThemedIcon(LucideReceipt, AccountBookOutlined, 'Receipt');
export const ReceiptText = /* @__PURE__ */ createThemedIcon(LucideReceiptText, AccountBookOutlined, 'ReceiptText');
export const Recycle = /* @__PURE__ */ createThemedIcon(LucideRecycle, RetweetOutlined, 'Recycle');
export const Redo2 = /* @__PURE__ */ createThemedIcon(LucideRedo2, RedoOutlined, 'Redo2');
export const RefreshCcw = /* @__PURE__ */ createThemedIcon(LucideRefreshCcw, ReloadOutlined, 'RefreshCcw');
export const RefreshCw = /* @__PURE__ */ createThemedIcon(LucideRefreshCw, ReloadOutlined, 'RefreshCw');
export const RemoveFormatting = /* @__PURE__ */ createThemedIcon(LucideRemoveFormatting, ClearOutlined, 'RemoveFormatting');
export const Reply = /* @__PURE__ */ createThemedIcon(LucideReply, RollbackOutlined, 'Reply');
export const RotateCcw = /* @__PURE__ */ createThemedIcon(LucideRotateCcw, RotateLeftOutlined, 'RotateCcw');
export const RotateCw = /* @__PURE__ */ createThemedIcon(LucideRotateCw, RotateRightOutlined, 'RotateCw');
export const Route = /* @__PURE__ */ createThemedIcon(LucideRoute, NodeIndexOutlined, 'Route');
export const Save = /* @__PURE__ */ createThemedIcon(LucideSave, SaveOutlined, 'Save');
export const Scale = /* @__PURE__ */ createThemedIcon(LucideScale, AuditOutlined, 'Scale');
export const ScaleIcon = /* @__PURE__ */ createThemedIcon(LucideScaleIcon, AuditOutlined, 'ScaleIcon');
export const School = /* @__PURE__ */ createThemedIcon(LucideSchool, BankOutlined, 'School');
export const ScrollText = /* @__PURE__ */ createThemedIcon(LucideScrollText, ProfileOutlined, 'ScrollText');
export const Search = /* @__PURE__ */ createThemedIcon(LucideSearch, SearchOutlined, 'Search');
export const Send = /* @__PURE__ */ createThemedIcon(LucideSend, SendOutlined, 'Send');
export const SendHorizonal = /* @__PURE__ */ createThemedIcon(LucideSendHorizonal, SendOutlined, 'SendHorizonal');
export const Server = /* @__PURE__ */ createThemedIcon(LucideServer, HddOutlined, 'Server');
export const Settings = /* @__PURE__ */ createThemedIcon(LucideSettings, SettingOutlined, 'Settings');
export const Settings2 = /* @__PURE__ */ createThemedIcon(LucideSettings2, SettingOutlined, 'Settings2');
export const Share2 = /* @__PURE__ */ createThemedIcon(LucideShare2, ShareAltOutlined, 'Share2');
export const Shield = /* @__PURE__ */ createThemedIcon(LucideShield, SafetyOutlined, 'Shield');
export const ShieldAlert = /* @__PURE__ */ createThemedIcon(LucideShieldAlert, WarningOutlined, 'ShieldAlert');
export const ShieldCheck = /* @__PURE__ */ createThemedIcon(LucideShieldCheck, SafetyCertificateOutlined, 'ShieldCheck');
export const ShieldOff = /* @__PURE__ */ createThemedIcon(LucideShieldOff, SecurityScanOutlined, 'ShieldOff');
export const ShieldQuestion = /* @__PURE__ */ createThemedIcon(LucideShieldQuestion, QuestionCircleOutlined, 'ShieldQuestion');
export const ShoppingBag = /* @__PURE__ */ createThemedIcon(LucideShoppingBag, ShoppingOutlined, 'ShoppingBag');
export const Sliders = /* @__PURE__ */ createThemedIcon(LucideSliders, SlidersOutlined, 'Sliders');
export const SlidersHorizontal = /* @__PURE__ */ createThemedIcon(LucideSlidersHorizontal, SlidersOutlined, 'SlidersHorizontal');
export const Smartphone = /* @__PURE__ */ createThemedIcon(LucideSmartphone, MobileOutlined, 'Smartphone');
export const Smile = /* @__PURE__ */ createThemedIcon(LucideSmile, SmileOutlined, 'Smile');
export const Space = /* @__PURE__ */ createThemedIcon(LucideSpace, CompressOutlined, 'Space');
export const Sparkles = /* @__PURE__ */ createThemedIcon(LucideSparkles, BulbOutlined, 'Sparkles');
export const Square = /* @__PURE__ */ createThemedIcon(LucideSquare, BorderOutlined, 'Square');
export const Stamp = /* @__PURE__ */ createThemedIcon(LucideStamp, AuditOutlined, 'Stamp');
export const Star = /* @__PURE__ */ createThemedIcon(LucideStar, StarOutlined, 'Star');
export const Stethoscope = /* @__PURE__ */ createThemedIcon(LucideStethoscope, MedicineBoxOutlined, 'Stethoscope');
export const StickyNote = /* @__PURE__ */ createThemedIcon(LucideStickyNote, FileTextOutlined, 'StickyNote');
export const Strikethrough = /* @__PURE__ */ createThemedIcon(LucideStrikethrough, StrikethroughOutlined, 'Strikethrough');
export const Sun = /* @__PURE__ */ createThemedIcon(LucideSun, SunOutlined, 'Sun');
export const Sunrise = /* @__PURE__ */ createThemedIcon(LucideSunrise, SunOutlined, 'Sunrise');
export const Sunset = /* @__PURE__ */ createThemedIcon(LucideSunset, SunOutlined, 'Sunset');
export const Table = /* @__PURE__ */ createThemedIcon(LucideTable, TableOutlined, 'Table');
export const Tablet = /* @__PURE__ */ createThemedIcon(LucideTablet, TabletOutlined, 'Tablet');
export const Tag = /* @__PURE__ */ createThemedIcon(LucideTag, TagOutlined, 'Tag');
export const Tags = /* @__PURE__ */ createThemedIcon(LucideTags, TagsOutlined, 'Tags');
export const Target = /* @__PURE__ */ createThemedIcon(LucideTarget, AimOutlined, 'Target');
export const ThumbsDown = /* @__PURE__ */ createThemedIcon(LucideThumbsDown, DislikeOutlined, 'ThumbsDown');
export const ThumbsUp = /* @__PURE__ */ createThemedIcon(LucideThumbsUp, LikeOutlined, 'ThumbsUp');
export const Ticket = /* @__PURE__ */ createThemedIcon(LucideTicket, TagOutlined, 'Ticket');
export const TicketPercent = /* @__PURE__ */ createThemedIcon(LucideTicketPercent, PercentageOutlined, 'TicketPercent');
export const Timer = /* @__PURE__ */ createThemedIcon(LucideTimer, ClockCircleOutlined, 'Timer');
export const ToggleLeft = /* @__PURE__ */ createThemedIcon(LucideToggleLeft, SwitcherOutlined, 'ToggleLeft');
export const ToggleRight = /* @__PURE__ */ createThemedIcon(LucideToggleRight, SwitcherOutlined, 'ToggleRight');
export const Train = /* @__PURE__ */ createThemedIcon(LucideTrain, CarOutlined, 'Train');
export const Trash2 = /* @__PURE__ */ createThemedIcon(LucideTrash2, DeleteOutlined, 'Trash2');
export const TrendingDown = /* @__PURE__ */ createThemedIcon(LucideTrendingDown, FallOutlined, 'TrendingDown');
export const TrendingUp = /* @__PURE__ */ createThemedIcon(LucideTrendingUp, RiseOutlined, 'TrendingUp');
export const Trophy = /* @__PURE__ */ createThemedIcon(LucideTrophy, TrophyOutlined, 'Trophy');
export const Truck = /* @__PURE__ */ createThemedIcon(LucideTruck, TruckOutlined, 'Truck');
export const Twitter = /* @__PURE__ */ createThemedIcon(LucideTwitter, TwitterOutlined, 'Twitter');
export const Type = /* @__PURE__ */ createThemedIcon(LucideType, FontSizeOutlined, 'Type');
export const Underline = /* @__PURE__ */ createThemedIcon(LucideUnderline, UnderlineOutlined, 'Underline');
export const Undo2 = /* @__PURE__ */ createThemedIcon(LucideUndo2, UndoOutlined, 'Undo2');
export const Unlock = /* @__PURE__ */ createThemedIcon(LucideUnlock, UnlockOutlined, 'Unlock');
export const Upload = /* @__PURE__ */ createThemedIcon(LucideUpload, UploadOutlined, 'Upload');
export const UploadCloud = /* @__PURE__ */ createThemedIcon(LucideUploadCloud, UploadOutlined, 'UploadCloud');
export const User = /* @__PURE__ */ createThemedIcon(LucideUser, UserOutlined, 'User');
export const UserCheck = /* @__PURE__ */ createThemedIcon(LucideUserCheck, UserSwitchOutlined, 'UserCheck');
export const UserCircle = /* @__PURE__ */ createThemedIcon(LucideUserCircle, UserOutlined, 'UserCircle');
export const UserCircle2 = /* @__PURE__ */ createThemedIcon(LucideUserCircle2, UserOutlined, 'UserCircle2');
export const UserIcon = /* @__PURE__ */ createThemedIcon(LucideUserIcon, UserOutlined, 'UserIcon');
export const UserPlus = /* @__PURE__ */ createThemedIcon(LucideUserPlus, UserAddOutlined, 'UserPlus');
export const UserRound = /* @__PURE__ */ createThemedIcon(LucideUserRound, UserOutlined, 'UserRound');
export const UserX = /* @__PURE__ */ createThemedIcon(LucideUserX, UserDeleteOutlined, 'UserX');
export const Users = /* @__PURE__ */ createThemedIcon(LucideUsers, TeamOutlined, 'Users');
export const UsersRound = /* @__PURE__ */ createThemedIcon(LucideUsersRound, TeamOutlined, 'UsersRound');
export const Utensils = /* @__PURE__ */ createThemedIcon(LucideUtensils, ShopOutlined, 'Utensils');
export const Video = /* @__PURE__ */ createThemedIcon(LucideVideo, VideoCameraOutlined, 'Video');
export const Wallet = /* @__PURE__ */ createThemedIcon(LucideWallet, WalletOutlined, 'Wallet');
export const WalletCards = /* @__PURE__ */ createThemedIcon(LucideWalletCards, WalletOutlined, 'WalletCards');
export const Wand2 = /* @__PURE__ */ createThemedIcon(LucideWand2, FormatPainterOutlined, 'Wand2');
export const Waves = /* @__PURE__ */ createThemedIcon(LucideWaves, LineChartOutlined, 'Waves');
export const Webhook = /* @__PURE__ */ createThemedIcon(LucideWebhook, ApiOutlined, 'Webhook');
export const Workflow = /* @__PURE__ */ createThemedIcon(LucideWorkflow, PartitionOutlined, 'Workflow');
export const X = /* @__PURE__ */ createThemedIcon(LucideX, CloseOutlined, 'X');
export const XCircle = /* @__PURE__ */ createThemedIcon(LucideXCircle, CloseCircleOutlined, 'XCircle');
export const Zap = /* @__PURE__ */ createThemedIcon(LucideZap, ThunderboltOutlined, 'Zap');
export const ZoomIn = /* @__PURE__ */ createThemedIcon(LucideZoomIn, ZoomInOutlined, 'ZoomIn');
export const ZoomOut = /* @__PURE__ */ createThemedIcon(LucideZoomOut, ZoomOutOutlined, 'ZoomOut');
