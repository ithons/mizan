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
  plaidApi,
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

import { PlaidSection } from './PlaidSection';
import { CoinbaseSection } from './CoinbaseSection';
import { CategoriesSection } from './CategoriesSection';
import { RulesSection } from './RulesSection';
import { DataSection } from './DataSection';
import { AboutSection } from './AboutSection';
type SettingsSection = "plaid" | "coinbase" | "categories" | "rules" | "data" | "about";
const sectionItems: { key: SettingsSection; label: string; icon: any }[] = [
  { key: "plaid", label: "Plaid", icon: Link2 },
  { key: "coinbase", label: "Coinbase", icon: Wallet },
  { key: "categories", label: "Categories", icon: Tag },
  { key: "rules", label: "Rules", icon: CheckCircle },
  { key: "data", label: "Data", icon: Database },
  { key: "about", label: "About", icon: Info },
];
function settingsSection(value: string | null): SettingsSection {
  return sectionItems.some((section) => section.key === value)
    ? value as SettingsSection
    : "plaid";
}



export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeSection, setActiveSection] = useState<SettingsSection>(() =>
    settingsSection(searchParams.get('section'))
  );

  useEffect(() => {
    setActiveSection(settingsSection(searchParams.get('section')));
  }, [searchParams]);

  const selectSection = (section: SettingsSection) => {
    setActiveSection(section);
    setSearchParams({ section }, { replace: true });
  };

  return (
    <div className="p-6 flex gap-6">
      {/* Section nav */}
      <div className="w-44 flex-shrink-0">
        <h1 className="text-xl font-semibold text-text mb-4">Settings</h1>
        <nav className="space-y-0.5">
          {sectionItems.map((s) => {
            const Icon = s.icon;
            const active = activeSection === s.key;
            return (
              <button
                key={s.key}
                onClick={() => selectSection(s.key)}
                className={`w-full text-left px-3 py-2 text-sm rounded transition-colors flex items-center gap-2.5 ${
                  active
                    ? 'bg-[#eaf7f3] text-text'
                    : 'text-muted hover:text-text'
                }`}
              >
                <Icon size={14} className={active ? 'text-green' : 'text-muted'} />
                {s.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 max-w-2xl">
        <div className="bg-surface shadow-sm border border-border rounded p-6">
          <h2 className="text-base font-semibold text-text mb-6">
            {sectionItems.find((s) => s.key === activeSection)?.label}
          </h2>
          {activeSection === 'plaid' && <PlaidSection />}
          {activeSection === 'coinbase' && <CoinbaseSection />}
          {activeSection === 'categories' && <CategoriesSection />}
          {activeSection === 'rules' && <RulesSection />}
          {activeSection === 'data' && <DataSection />}
          {activeSection === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
