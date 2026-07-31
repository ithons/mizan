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

/**
 * The eight identity slots, in fixed order, and the ONLY copy of them.
 *
 * There used to be a second copy: sixteen `--mz-cat-*` custom properties in client/src/index.css
 * and eight `cat-1..8` entries in tailwind.config.js. Nothing referenced either, and the ramp
 * emitted zero utilities into the built CSS, so it was two lists to keep in sync in exchange for
 * nothing. Both are gone; tests/categoryRamp.test.ts fails if a copy comes back.
 *
 * Literal hexes rather than tokens, because a category's colour is written to `categories.color`
 * in SQLite and a stored hex cannot follow a theme. These eight were therefore solved for the
 * INTERSECTION of the two lightness bands the dataviz checks impose (light 0.43-0.77, dark
 * 0.48-0.67 in OKLCH L) at chroma 0.13, hue order designed rather than searched: the Balance
 * semantics first (sage 145, gold 72, clay 32), then four extensions.
 *
 * Verified with the validator against all four grounds (light/dark x paper/card): lightness band
 * PASS, chroma floor PASS, CVD separation PASS (worst adjacent pair #c68627 vs #207029, 13.0 ΔE
 * protan, target 8.0), normal-vision floor PASS (worst adjacent #ad4d3c vs #c68627, 15.7 ΔE,
 * floor 15.0). Contrast against the surfaces lands in the 2.1-3.0 band, which the checks flag as
 * WARN and which obligates relief rather than forbidding the colour; the relief is structural,
 * since a swatch never appears without its category name beside it. Do not use these as text.
 *
 * Twelve became eight. The twelve were arbitrary: two of them (`#cbb08a`, `#a7bb92` in the sibling
 * chart palette) were 5.4 ΔE apart, which is indistinguishable to a reader with full colour vision,
 * let alone under protanopia. Eight that provably separate is a longer list than twelve that do not.
 */
const CATEGORY_PRESET_COLORS = [
  '#207029', '#c68627', '#ad4d3c', '#02a6ad',
  '#92417a', '#4c88d3', '#979828', '#6a51a4',
];

function isOnRamp(color: string): boolean {
  return CATEGORY_PRESET_COLORS.some((c) => c.toLowerCase() === color.toLowerCase());
}

/**
 * The swatch row.
 *
 * Editing CATEGORY_PRESET_COLORS changes what a NEW pick offers and nothing else, because the
 * colour is persisted per row. That is not hypothetical: every category in the owner's ledger
 * stores a hex from the retired twelve-colour palette and none stores one from this ramp.
 *
 *   sqlite3 .mizan/mizan.db "select sum(case when lower(color) in ('#207029','#c68627','#ad4d3c',
 *     '#02a6ad','#92417a','#4c88d3','#979828','#6a51a4') then 1 else 0 end) on_ramp, count(*)
 *     total from categories;"
 *   -> 0|71
 *
 * A picker that rendered only the ramp therefore showed nothing selected on all 71 rows, which
 * both hid the colour the row actually wears and gave no way to tell an off-ramp colour from an
 * unset one. The stored colour is shown first, outlined as the current pick, and ringed so it
 * reads as the odd one out rather than as a ninth slot. Rows are moved onto the ramp by choosing,
 * not by a migration: overwriting a colour the owner set is not this component's call.
 */
function ColorPicker({
  value,
  onChange,
  size,
}: {
  value: string;
  onChange: (color: string) => void;
  size: 'sm' | 'md';
}) {
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const swatch = (color: string, offRamp: boolean) => (
    <button
      key={color}
      type="button"
      onClick={() => onChange(color)}
      className={`${dim} rounded-full transition-transform hover:scale-110 ${
        offRamp ? 'ring-1 ring-inset ring-ink/30' : ''
      }`}
      style={{
        backgroundColor: color,
        outline: value.toLowerCase() === color.toLowerCase() ? '2px solid var(--mz-ink)' : '2px solid transparent',
        outlineOffset: '1px',
      }}
      title={offRamp ? `${color} · current colour, not on the ramp` : color}
    />
  );

  return (
    <div className={`flex flex-wrap items-center ${size === 'sm' ? 'gap-1' : 'gap-2'}`}>
      {!isOnRamp(value) && swatch(value, true)}
      {CATEGORY_PRESET_COLORS.map((color) => swatch(color, false))}
    </div>
  );
}

export function invalidateCategoryData(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['categories'] });
  invalidateFinancialData(queryClient);
}

function Badge({ tone, children }: { tone: 'sage' | 'clay' | 'muted'; children: string }) {
  const color = tone === 'sage' ? 'text-sage-deep' : tone === 'clay' ? 'text-clay' : 'text-muted';
  return (
    <span className={`flex-shrink-0 rounded border border-pill-border bg-pill-bg px-1.5 py-0.5 text-micro ${color}`}>
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
    'rounded-md border border-line-3 bg-card px-2 py-1 text-note text-ink placeholder:text-muted-2 focus:outline-none focus:border-sage';

  return (
    <div>
      <div
        className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-well"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: category.color || 'var(--mz-dot)' }} />
        {category.icon && !editing && <span className="text-body-lg">{category.icon}</span>}
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
            <ColorPicker value={editColor} onChange={setEditColor} size="sm" />
          </div>
        ) : (
          <>
            <span className="flex-1 text-body-lg text-ink">{category.name}</span>
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
        {categories.length === 0 && <p className="py-4 text-note text-muted-2">No categories yet.</p>}
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
            <ColorPicker value={addColor} onChange={setAddColor} size="md" />
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
