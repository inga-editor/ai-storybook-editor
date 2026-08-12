// error-message-table.ts — Hard-coded code → { title, description } copy for the error
// state. SECURITY (design §4.2): we NEVER echo the server-provided `message`; the display
// text is fully client-owned, keyed only by the error CODE. This blocks any
// injection/leak via an attacker-influenced server message string.
import type { RemixEditorErrorDisplayCode } from '../types/remix-editor-status';

export interface ErrorMessageCopy {
  title: string;
  description: string;
}

/** Complete map covering every RemixEditorErrorDisplayCode (Vietnamese copy). */
const ERROR_MESSAGE_TABLE: Record<RemixEditorErrorDisplayCode, ErrorMessageCopy> = {
  BOOK_ID_MISSING: {
    title: 'Đường dẫn không hợp lệ',
    description: 'Liên kết thiếu mã sách. Vui lòng mở lại từ Admin App.',
  },
  TOKEN_MISSING: {
    title: 'Thiếu thông tin truy cập',
    description: 'Không nhận được phiên làm việc. Vui lòng mở lại từ Admin App.',
  },
  TOKEN_INVALID: {
    title: 'Phiên không hợp lệ',
    description: 'Thông tin truy cập không hợp lệ. Vui lòng mở lại từ Admin App.',
  },
  TOKEN_EXPIRED: {
    title: 'Phiên đã hết hạn',
    description: 'Phiên làm việc đã hết hạn. Vui lòng mở lại từ Admin App.',
  },
  HANDOFF_INVALID: {
    title: 'Bàn giao không hợp lệ',
    description: 'Không thể xác thực phiên bàn giao. Vui lòng mở lại từ Admin App.',
  },
  SESSION_EXPIRED: {
    title: 'Phiên đã hết hạn',
    description: 'Phiên làm việc đã kết thúc. Vui lòng mở lại từ Admin App.',
  },
  FORBIDDEN: {
    title: 'Không có quyền truy cập',
    description: 'Bạn không có quyền chỉnh sửa nội dung này.',
  },
  NOT_FOUND: {
    title: 'Không tìm thấy',
    description: 'Không tìm thấy sách hoặc bản remix tương ứng.',
  },
  RATE_LIMITED: {
    title: 'Thao tác quá nhanh',
    description: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau giây lát.',
  },
  VALIDATION_ERROR: {
    title: 'Dữ liệu không hợp lệ',
    description: 'Yêu cầu không hợp lệ. Vui lòng thử lại.',
  },
  NETWORK: {
    title: 'Mất kết nối',
    description: 'Mất kết nối mạng. Vui lòng kiểm tra và thử lại.',
  },
  SERVER: {
    title: 'Đã xảy ra lỗi',
    description: 'Hệ thống gặp sự cố. Vui lòng thử lại.',
  },
};

/** Default copy for any unexpected/unmapped code (defensive; keeps UI safe). */
const FALLBACK_COPY: ErrorMessageCopy = ERROR_MESSAGE_TABLE.SERVER;

/** Resolve display copy for an error code (never throws; falls back to SERVER copy). */
export function errorMessageFor(code: RemixEditorErrorDisplayCode | undefined): ErrorMessageCopy {
  if (!code) return FALLBACK_COPY;
  return ERROR_MESSAGE_TABLE[code] ?? FALLBACK_COPY;
}
