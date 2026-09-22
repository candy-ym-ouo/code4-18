<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError, download } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import {
  integrityStatusLabels,
  integrityStatusTagTypes,
  ownerTypeLabels,
  type ApiMeta,
  type AttachmentIntegrityEntry,
  type AttachmentIntegrityScanResult,
  type AttachmentIntegrityStatus,
  type AttachmentIntegritySummary
} from "@/types";

const router = useRouter();
const auth = useAuthStore();
const saving = ref(false);
const form = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
async function exportFile(path: string) {
  try {
    await download(path);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "导出失败");
  }
}
async function changePassword() {
  if (form.newPassword !== form.confirmPassword) { ElMessage.error("两次输入的新密码不一致"); return; }
  saving.value = true;
  try {
    await request<void>("/auth/password", { method: "POST", body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
    auth.user = null;
    ElMessage.success("密码已修改，请重新登录");
    await router.push("/login");
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "密码修改失败"); }
  finally { saving.value = false; }
}

const scanning = ref(false);
const entriesLoading = ref(false);
const summary = ref<AttachmentIntegritySummary | null>(null);
const entries = ref<AttachmentIntegrityEntry[]>([]);
const entriesMeta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const statusFilter = ref<AttachmentIntegrityStatus | "">("");
const statusOptions = Object.entries(integrityStatusLabels) as [AttachmentIntegrityStatus, string][];

async function loadSummary() {
  try {
    const response = await request<{ data: AttachmentIntegritySummary }>("/attachment-integrity/summary");
    summary.value = response.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "完整性概览加载失败");
  }
}

async function loadEntries(page = 1) {
  entriesLoading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (statusFilter.value) params.set("status", statusFilter.value);
    const response = await request<{ data: AttachmentIntegrityEntry[]; meta: ApiMeta }>(`/attachment-integrity/entries?${params}`);
    entries.value = response.data;
    Object.assign(entriesMeta, response.meta);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "完整性索引加载失败");
  } finally {
    entriesLoading.value = false;
  }
}

async function reindex() {
  scanning.value = true;
  try {
    const response = await request<{ data: AttachmentIntegrityScanResult }>("/attachment-integrity/reindex", { method: "POST" });
    const result = response.data;
    ElMessage.success(`索引完成：${result.entriesWritten} 个条目，移除 ${result.entriesRemoved} 个已消失对象`);
    await Promise.all([loadSummary(), loadEntries(1)]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "重新索引失败");
  } finally {
    scanning.value = false;
  }
}

function problemCount(): number {
  if (!summary.value) return 0;
  const counts = summary.value.statusCounts;
  return summary.value.totalEntries - (counts.OK ?? 0);
}

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : "—";
}

onMounted(() => {
  void loadSummary();
  void loadEntries();
});
</script>

<template>
  <div>
    <header class="page-header"><div><h1>设置与数据</h1><p>导出真实工作区数据，或更新操作员密码。</p></div></header>
    <div class="two-column">
      <section class="panel">
        <h2>数据导出</h2>
        <p class="muted">导出内容来自 PostgreSQL 当前数据，不生成任何占位数据。</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <el-button @click="exportFile('/exports/materials.csv')">导出材料 CSV</el-button>
          <el-button @click="exportFile('/exports/batches.csv')">导出批次 CSV</el-button>
          <el-button type="primary" @click="exportFile('/exports/workspace.json')">导出完整工作区 JSON</el-button>
        </div>
        <h3 style="margin-top:28px">运维说明</h3>
        <p class="muted">应定期备份 PostgreSQL 数据库和附件目录。生产环境必须使用强密码、HTTPS 和持久化存储。</p>
      </section>
      <section class="panel">
        <h2>修改密码</h2>
        <el-form label-position="top">
          <el-form-item label="当前密码"><el-input v-model="form.currentPassword" type="password" show-password /></el-form-item>
          <el-form-item label="新密码"><el-input v-model="form.newPassword" type="password" show-password placeholder="至少 10 位" /></el-form-item>
          <el-form-item label="确认新密码"><el-input v-model="form.confirmPassword" type="password" show-password /></el-form-item>
          <el-button type="primary" :loading="saving" @click="changePassword">修改密码</el-button>
        </el-form>
      </section>
    </div>
    <section class="panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div>
          <h2 style="margin:0 0 6px">附件完整性索引</h2>
          <p class="muted" style="margin:0">校验附件哈希、归属记录和文件引用关系，并扫描孤立文件。索引只报告问题，不会改动附件数据或文件。</p>
        </div>
        <el-button type="primary" :loading="scanning" @click="reindex">重新索引</el-button>
      </div>
      <div v-if="summary" style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0">
        <el-tag type="info" effect="plain">总条目 {{ summary.totalEntries }}</el-tag>
        <el-tag v-for="[status, label] in statusOptions" :key="status" :type="integrityStatusTagTypes[status]" :effect="summary.statusCounts[status] > 0 && status !== 'OK' ? 'dark' : 'plain'">
          {{ label }} {{ summary.statusCounts[status] }}
        </el-tag>
        <el-tag v-if="summary.lastScannedAt" type="info" effect="plain">上次扫描 {{ new Date(summary.lastScannedAt).toLocaleString() }}</el-tag>
        <el-tag v-else type="warning" effect="plain">尚未扫描</el-tag>
      </div>
      <el-alert v-if="summary && problemCount() > 0" type="warning" :closable="false" show-icon
        :title="`发现 ${problemCount()} 个异常对象，请核对后人工处理；索引不会自动修复或替换任何数据。`" style="margin-bottom:12px" />
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <el-select v-model="statusFilter" placeholder="全部状态" clearable style="width:180px" @change="loadEntries(1)">
          <el-option v-for="[status, label] in statusOptions" :key="status" :label="label" :value="status" />
        </el-select>
      </div>
      <el-table v-loading="entriesLoading" :data="entries">
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag :type="integrityStatusTagTypes[row.status as AttachmentIntegrityStatus]" size="small">{{ integrityStatusLabels[row.status as AttachmentIntegrityStatus] }}</el-tag></template>
        </el-table-column>
        <el-table-column label="存储键" min-width="220">
          <template #default="{ row }"><code style="word-break:break-all">{{ row.storageKey }}</code></template>
        </el-table-column>
        <el-table-column label="归属" width="150">
          <template #default="{ row }">
            <span v-if="row.ownerType">{{ ownerTypeLabels[row.ownerType] ?? row.ownerType }}</span>
            <span v-else class="muted">无记录</span>
            <div v-if="row.ownerType && row.ownerPresent === false" class="muted">归属记录已不存在</div>
          </template>
        </el-table-column>
        <el-table-column label="期望哈希" width="120"><template #default="{ row }"><code>{{ shortHash(row.expectedSha256) }}</code></template></el-table-column>
        <el-table-column label="实际哈希" width="120"><template #default="{ row }"><code>{{ shortHash(row.actualSha256) }}</code></template></el-table-column>
        <el-table-column label="状态变化时间" width="180">
          <template #default="{ row }">{{ new Date(row.statusChangedAt).toLocaleString() }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!entriesLoading && entries.length === 0" description="索引为空，点击“重新索引”开始第一次扫描" :image-size="70" />
      <el-pagination v-if="entriesMeta.total > 0" style="margin-top:16px;justify-content:flex-end" layout="total, prev, pager, next" :total="entriesMeta.total" :page-size="entriesMeta.pageSize" :current-page="entriesMeta.page" @current-change="loadEntries" />
    </section>
  </div>
</template>
