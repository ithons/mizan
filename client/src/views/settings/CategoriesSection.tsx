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

export function invalidateCategoryData(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['categories'] });
  invalidateFinancialData(queryClient);
}

// ─── Plaid Section ────────────────────────────────────────────────────────────

export function CategoryRow({
  category,
  onEdit,
  onDelete,
  onAddChild,
  depth,
}: {
  category: Category;
  onEdit: (id: string, name: string, color: string, icon: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  depth: number;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(category.name);
  const [editColor, setEditColor] = useState(category.color || CATEGORY_PRESET_COLORS[0]);
  const [editIcon, setEditIcon] = useState(category.icon || '');

  const handleSave = () => {
    onEdit(category.id, editName, editColor, editIcon);
    setEditing(false);
  };

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 hover:bg-black/5 group rounded px-2"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: category.color || '#6b6b7a' }} />
        {category.icon && !editing && <span className="text-sm">{category.icon}</span>}
        {editing ? (
          <div className="flex flex-col gap-2 flex-1 py-1">
            <div className="flex items-center gap-1">
              <input
                autoFocus
                className="bg-background border border-border rounded px-2 py-0.5 text-xs text-text flex-1 focus:outline-none focus:ring-1 focus:ring-green-50"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <input
                className="w-8 bg-background border border-border rounded px-1 py-0.5 text-xs text-center text-text focus:outline-none focus:ring-1 focus:ring-green-50"
                value={editIcon}
                onChange={(e) => setEditIcon(e.target.value)}
                maxLength={2}
                placeholder="🏠"
                title="Category icon (emoji)"
              />
              <button onClick={handleSave}>
                <Check size={12} className="text-green" />
              </button>
              <button onClick={() => setEditing(false)}>
                <X size={12} className="text-muted" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {CATEGORY_PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setEditColor(color)}
                  className="w-4 h-4 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: color,
                    outline: editColor === color ? `2px solid white` : '2px solid transparent',
                    outlineOffset: '1px',
                  }}
                  title={color}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            <span className="text-sm text-text flex-1">{category.name}</span>
            {category.is_income && <span className="text-xs text-green bg-green-10 px-1.5 py-0.5 rounded">income</span>}
            {category.is_system && <span className="text-xs text-muted bg-border/50 px-1.5 py-0.5 rounded">system</span>}
          </>
        )}
        {!editing && (
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {depth === 0 && (
              <button
                className="p-1 text-muted hover:text-green"
                title="Add subcategory"
                onClick={() => onAddChild(category.id)}
              >
                <Plus size={12} />
              </button>
            )}
            {!category.is_system && (
              <>
                <button
                  className="p-1 text-muted hover:text-text"
                  onClick={() => {
                    setEditName(category.name);
                    setEditColor(category.color || CATEGORY_PRESET_COLORS[0]);
                    setEditIcon(category.icon || '');
                    setEditing(true);
                  }}
                >
                  <Edit2 size={12} />
                </button>
                <button className="p-1 text-muted hover:text-rose" onClick={() => onDelete(category.id)}>
                  <Trash2 size={12} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {category.children?.map((child) => (
        <CategoryRow
          key={child.id}
          category={child}
          onEdit={onEdit}
          onDelete={onDelete}
          onAddChild={onAddChild}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function CategoriesSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [addParentId, setAddParentId] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addColor, setAddColor] = useState(CATEGORY_PRESET_COLORS[0]);
  const [addIcon, setAddIcon] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });

  const editMutation = useMutation({
    mutationFn: ({ id, name, color, icon }: { id: string; name: string; color: string; icon: string }) =>
      categoriesApi.update(id, { name, color, icon }),
    onSuccess: () => invalidateCategoryData(qc),
  });

  const deleteMutation = useMutation({
    mutationFn: categoriesApi.delete,
    onSuccess: () => invalidateCategoryData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const addMutation = useMutation({
    mutationFn: () =>
      categoriesApi.create({
        name: addName,
        color: addColor,
        icon: addIcon || undefined,
        parent_id: addParentId ?? undefined,
        is_income: false,
        is_system: false,
        is_investment: false,
        sort_order: 0,
      }),
    onSuccess: () => {
      invalidateCategoryData(qc);
      setAddName('');
      setAddColor(CATEGORY_PRESET_COLORS[0]);
      setAddIcon('');
      setShowAddModal(false);
      addToast({ type: 'success', message: 'Category created' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const rootCategories = categories.filter((c) => !c.parent_id);

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text">Categories</h3>
        <button
          className="flex items-center gap-1 text-xs text-green hover:opacity-80"
          onClick={() => { setAddParentId(null); setShowAddModal(true); }}
        >
          <Plus size={13} /> Add Category
        </button>
      </div>
      <div className="bg-background border border-border rounded py-2">
        {rootCategories.map((cat) => (
          <CategoryRow
            key={cat.id}
            category={cat}
            onEdit={(id, name, color, icon) => editMutation.mutate({ id, name, color, icon })}
            onDelete={(id) => deleteMutation.mutate(id)}
            onAddChild={(parentId) => { setAddParentId(parentId); setShowAddModal(true); }}
            depth={0}
          />
        ))}
        {categories.length === 0 && (
          <p className="text-xs text-muted text-center py-6">No categories yet</p>
        )}
      </div>

      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={addParentId ? 'Add Subcategory' : 'Add Category'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">Name</label>
            <div className="flex gap-2">
              <input
                autoFocus
                className="flex-1 bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMutation.mutate()}
                placeholder="Category name"
              />
              <input
                className="w-10 bg-background border border-border rounded px-2 py-2 text-sm text-center text-text focus:outline-none focus:ring-1 focus:ring-green-50"
                value={addIcon}
                onChange={(e) => setAddIcon(e.target.value)}
                maxLength={2}
                placeholder="🏠"
                title="Icon (emoji)"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted mb-2">Color</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setAddColor(color)}
                  className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: color,
                    outline: addColor === color ? '2px solid white' : '2px solid transparent',
                    outlineOffset: '1px',
                  }}
                  title={color}
                />
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <button
              className="flex-1 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90"
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !addName}
            >
              {addMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
              onClick={() => setShowAddModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── Rules Section ────────────────────────────────────────────────────────────
