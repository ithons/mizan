import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Plus, Trash2, Edit2, X, Check } from 'lucide-react';
import { categoriesApi } from '../../lib/api';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { Modal } from '../../components/Modal';
import { PageLoader } from '../../components/LoadingSpinner';
import { InkButton, SectionLabel, TextButton } from '../../components/balance';
import type { Category } from '@shared/types';

const CATEGORY_PRESET_COLORS = [
  '#c9963a', '#7c8b99', '#b5654a', '#ce8642', '#9b8dee',
  '#ee8d5b', '#70c4e0', '#e070b8', '#70e07a', '#a0a0b8',
  '#c4a86e', '#6e8ec4',
];

export function invalidateCategoryData(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['categories'] });
  invalidateFinancialData(queryClient);
}

function Badge({ tone, children }: { tone: 'sage' | 'clay' | 'muted'; children: string }) {
  const color = tone === 'sage' ? 'text-sage-deep' : tone === 'clay' ? 'text-clay' : 'text-muted';
  return (
    <span className={`flex-shrink-0 rounded border border-pill-border bg-pill-bg px-1.5 py-0.5 text-[11px] ${color}`}>
      {children}
    </span>
  );
}

// ─── Category Row ────────────────────────────────────────────────────────────

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

  const smallField =
    'rounded-md border border-line-3 bg-card px-2 py-1 text-xs text-ink placeholder:text-muted-2 focus:outline-none focus:border-sage';

  return (
    <div>
      <div
        className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-rail"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: category.color || '#7a6c5d' }} />
        {category.icon && !editing && <span className="text-sm">{category.icon}</span>}
        {editing ? (
          <div className="flex flex-1 flex-col gap-2 py-1">
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                className={`flex-1 ${smallField}`}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <input
                className={`w-9 text-center ${smallField}`}
                value={editIcon}
                onChange={(e) => setEditIcon(e.target.value)}
                maxLength={2}
                placeholder="🏠"
                title="Category icon (emoji)"
              />
              <button type="button" onClick={handleSave}>
                <Check size={13} className="text-sage-deep" />
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                <X size={13} className="text-muted" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {CATEGORY_PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setEditColor(color)}
                  className="h-4 w-4 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: color,
                    outline: editColor === color ? '2px solid var(--mz-ink)' : '2px solid transparent',
                    outlineOffset: '1px',
                  }}
                  title={color}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            <span className="flex-1 text-sm text-ink">{category.name}</span>
            {Boolean(category.is_income) && <Badge tone="sage">income</Badge>}
            {Boolean(category.is_system) && <Badge tone="muted">system</Badge>}
          </>
        )}
        {!editing && (
          <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {depth === 0 && (
              <button
                type="button"
                className="p-1 text-muted transition-colors hover:text-sage-deep"
                title="Add subcategory"
                onClick={() => onAddChild(category.id)}
              >
                <Plus size={12} />
              </button>
            )}
            {!category.is_system && (
              <>
                <button
                  type="button"
                  className="p-1 text-muted transition-colors hover:text-ink"
                  onClick={() => {
                    setEditName(category.name);
                    setEditColor(category.color || CATEGORY_PRESET_COLORS[0]);
                    setEditIcon(category.icon || '');
                    setEditing(true);
                  }}
                >
                  <Edit2 size={12} />
                </button>
                <button
                  type="button"
                  className="p-1 text-muted transition-colors hover:text-clay"
                  onClick={() => onDelete(category.id)}
                >
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
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <SectionLabel>Categories</SectionLabel>
        <TextButton
          onClick={() => {
            setAddParentId(null);
            setShowAddModal(true);
          }}
        >
          + Add category
        </TextButton>
      </div>
      <div>
        {rootCategories.map((cat) => (
          <CategoryRow
            key={cat.id}
            category={cat}
            onEdit={(id, name, color, icon) => editMutation.mutate({ id, name, color, icon })}
            onDelete={(id) => deleteMutation.mutate(id)}
            onAddChild={(parentId) => {
              setAddParentId(parentId);
              setShowAddModal(true);
            }}
            depth={0}
          />
        ))}
        {categories.length === 0 && <p className="py-4 text-xs text-muted-2">No categories yet.</p>}
      </div>

      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={addParentId ? 'Add subcategory' : 'Add category'}
      >
        <div className="space-y-4">
          <div>
            <label className="mz-label">Name</label>
            <div className="flex gap-2">
              <input
                autoFocus
                className="mz-field flex-1"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMutation.mutate()}
                placeholder="Category name"
              />
              <input
                className="mz-field !w-12 text-center"
                value={addIcon}
                onChange={(e) => setAddIcon(e.target.value)}
                maxLength={2}
                placeholder="🏠"
                title="Icon (emoji)"
              />
            </div>
          </div>
          <div>
            <label className="mz-label">Color</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setAddColor(color)}
                  className="h-5 w-5 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: color,
                    outline: addColor === color ? '2px solid var(--mz-ink)' : '2px solid transparent',
                    outlineOffset: '1px',
                  }}
                  title={color}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-5 pt-1">
            <InkButton onClick={() => addMutation.mutate()} disabled={addMutation.isPending || !addName}>
              {addMutation.isPending ? 'Creating…' : 'Create'}
            </InkButton>
            <TextButton onClick={() => setShowAddModal(false)}>Cancel</TextButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}
