export type ApiMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Material = {
  id: string;
  code: string | null;
  name: string;
  craftTypes: string[];
  subtype: string | null;
  stockUnit: string;
  lowStockThreshold: string | null;
  defaultColorName: string | null;
  defaultColorHex: string | null;
  tags: string[];
  notes: string | null;
  remainingQuantity: string;
  batchCount: number;
  stockState: string;
  archivedAt: string | null;
  updatedAt: string;
  version: number;
};

export type Batch = {
  id: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  batchCode: string | null;
  sourceId: string | null;
  sourceName: string | null;
  locationId: string | null;
  locationName: string | null;
  receivedAt: string;
  expiryAt: string | null;
  initialQuantity: string;
  remainingQuantity: string;
  stockUnit: string;
  currentColorName: string | null;
  currentColorHex: string | null;
  status: string;
  notes: string | null;
  version: number;
  updatedAt: string;
};

export type Source = {
  id: string;
  name: string;
  type: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  notes: string | null;
  archivedAt: string | null;
  batchCount: number;
  activeBatchCount: number;
};

export type Location = {
  id: string;
  name: string;
  parentId: string | null;
  notes: string | null;
  batchCount: number;
  archivedAt: string | null;
};

export type Project = {
  id: string;
  name: string;
  craftType: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  description: string | null;
  targetColorName: string | null;
  targetColorHex: string | null;
  tags: string[];
  requirementCount: number;
  consumptionCount: number;
  version: number;
  updatedAt: string;
};

export type Consumption = {
  id: string;
  projectId: string;
  projectName: string;
  projectRequirementId: string | null;
  batchId: string;
  batchCode: string | null;
  materialId: string;
  materialName: string;
  sourceName: string | null;
  usedQuantity: string;
  wasteQuantity: string;
  totalQuantity: string;
  stockUnit: string;
  consumedAt: string;
  purpose: string | null;
  notes: string | null;
  status: string;
  reversedAt: string | null;
  reversalReason: string | null;
};

export const craftTypeLabels: Record<string, string> = {
  DYEING: "染布",
  WOODWORKING: "木工",
  POTTERY: "陶艺",
  METALWORKING: "金工",
  GENERAL: "通用",
  OTHER: "其他"
};

export const statusLabels: Record<string, string> = {
  ACTIVE: "有库存",
  DEPLETED: "已耗尽",
  ARCHIVED: "已归档",
  PLANNED: "计划中",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  REVERSED: "已撤销"
};

export const movementLabels: Record<string, string> = {
  OPENING: "初始入库",
  PURCHASE: "采购入库",
  CONSUMPTION: "材料消耗",
  ADJUSTMENT_IN: "盘增",
  ADJUSTMENT_OUT: "盘减",
  REVERSAL: "撤销恢复"
};

export type AttachmentIntegrityStatus = "OK" | "HASH_MISMATCH" | "FILE_MISSING" | "OWNER_MISSING" | "ORPHAN_FILE";

export type AttachmentIntegrityEntry = {
  storageKey: string;
  attachmentId: string | null;
  recordPresent: boolean;
  filePresent: boolean;
  ownerType: string | null;
  ownerId: string | null;
  ownerPresent: boolean | null;
  expectedSha256: string | null;
  expectedByteSize: string | null;
  actualSha256: string | null;
  actualByteSize: string | null;
  status: AttachmentIntegrityStatus;
  firstSeenAt: string;
  lastScannedAt: string;
  statusChangedAt: string;
};

export type AttachmentIntegritySummary = {
  totalEntries: number;
  statusCounts: Record<AttachmentIntegrityStatus, number>;
  lastScannedAt: string | null;
};

export type AttachmentIntegrityScanResult = {
  recordsScanned: number;
  filesScanned: number;
  transientFilesSkipped: number;
  invalidKeysSkipped: number;
  entriesWritten: number;
  entriesRemoved: number;
  statusCounts: Record<AttachmentIntegrityStatus, number>;
  scannedAt: string;
};

export const integrityStatusLabels: Record<AttachmentIntegrityStatus, string> = {
  OK: "正常",
  HASH_MISMATCH: "哈希冲突",
  FILE_MISSING: "文件缺失",
  OWNER_MISSING: "归属缺失",
  ORPHAN_FILE: "孤立文件"
};

export const integrityStatusTagTypes: Record<AttachmentIntegrityStatus, "success" | "danger" | "warning" | "info"> = {
  OK: "success",
  HASH_MISMATCH: "danger",
  FILE_MISSING: "danger",
  OWNER_MISSING: "warning",
  ORPHAN_FILE: "warning"
};

export const ownerTypeLabels: Record<string, string> = {
  BATCH: "批次",
  COLOR_CHANGE: "颜色变化",
  PROJECT: "项目",
  CONSUMPTION: "消耗"
};
