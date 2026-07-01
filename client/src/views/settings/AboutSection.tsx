import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Edit2,
  X,
  Check,
  AlertTriangle,
  Download,
  Link2,
  Unlink,
  RefreshCw,
  Info,
  Wallet,
  Tag,
  Database,
  CheckCircle,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  settingsApi,
  coinbaseApi,
  categoriesApi,
  rulesApi,
  syncApi,
  flattenCategories,
} from '../../lib/api';
import { formatRelativeTime } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { Modal } from '../../components/Modal';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import { PageLoader } from '../../components/LoadingSpinner';
import type { Category, MerchantRule, MerchantRuleSuggestion, SyncRun } from '@shared/types';

const CATEGORY_PRESET_COLORS = [
  '#32bfa3', '#6487f0', '#ef6f8a', '#e2a53f', '#9b8dee',
  '#ee8d5b', '#70c4e0', '#e070b8', '#70e07a', '#a0a0b8',
  '#c4a86e', '#6e8ec4',
];

export function AboutSection() {
  return (
    <div className="space-y-3 max-w-md">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted mb-0.5">Version</p>
          <p className="text-text font-mono">0.1.0</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-0.5">License</p>
          <p className="text-text">MIT</p>
        </div>
      </div>
      <p className="text-xs text-muted pt-2">
        Mizān is a self-hosted personal finance app. Your data never leaves your machine.
      </p>
    </div>
  );
}

// ─── Main Settings View ───────────────────────────────────────────────────────

type SettingsSection = 'plaid' | 'coinbase' | 'categories' | 'rules' | 'data' | 'about';

const sectionItems: { key: SettingsSection; label: string; icon: LucideIcon }[] = [
  { key: 'plaid', label: 'Plaid', icon: Link2 },
  { key: 'coinbase', label: 'Coinbase', icon: Wallet },
  { key: 'categories', label: 'Categories', icon: Tag },
  { key: 'rules', label: 'Rules', icon: CheckCircle },
  { key: 'data', label: 'Data', icon: Database },
  { key: 'about', label: 'About', icon: Info },
];
