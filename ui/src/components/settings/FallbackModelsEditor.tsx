import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X, Plus } from 'lucide-react';
import ModelPicker from './ModelPicker';
import type { ProviderOption } from './ModelPicker';

interface FallbackModel {
  id: string;
  provider: string;
  model: string;
}

interface FallbackModelsEditorProps {
  value: string[];
  onChange: (value: string[]) => void;
  configuredProviders?: string[];
  extraProviders?: ProviderOption[];
}

function SortableItem({ item, onUpdate, onRemove, configuredProviders, extraProviders }: {
  item: FallbackModel;
  onUpdate: (id: string, item: FallbackModel) => void;
  onRemove: (id: string) => void;
  configuredProviders?: string[];
  extraProviders?: ProviderOption[];
}) {
  const { t } = useTranslation('common');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="mt-2 cursor-grab touch-none text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
        title={t('common.dragToReorder')}
      >
        <GripVertical size={16} />
      </button>
      <div className="flex-1 min-w-0">
        <ModelPicker
          provider={item.provider}
          model={item.model}
          onChangeProvider={(provider) => onUpdate(item.id, { ...item, provider })}
          onChangeModel={(model) => onUpdate(item.id, { ...item, model })}
          providerLabel={t('settings.models.provider')}
          modelLabel={t('settings.models.model')}
          showMetaBadges={false}
          showTestButton={false}
          configuredProviders={configuredProviders}
          extraProviders={extraProviders}
          className="space-y-2"
        />
      </div>
      <button
        type="button"
        onClick={() => onRemove(item.id)}
        className="mt-2 text-neutral-400 hover:text-red-500 dark:hover:text-red-400"
        title={t('common.remove')}
      >
        <X size={16} />
      </button>
    </div>
  );
}

let nextId = 0;
function generateId(): string {
  return `fallback-${Date.now()}-${nextId++}`;
}

function parseValue(value: string[]): FallbackModel[] {
  return value.map((ref) => {
    const slashIdx = ref.indexOf('/');
    if (slashIdx > 0) {
      return { id: generateId(), provider: ref.slice(0, slashIdx), model: ref.slice(slashIdx + 1) };
    }
    return { id: generateId(), provider: '', model: ref };
  });
}

export default function FallbackModelsEditor({ value, onChange, configuredProviders, extraProviders }: FallbackModelsEditorProps) {
  const { t } = useTranslation('common');
  const [items, setItems] = useState<FallbackModel[]>(() => parseValue(value));
  const [lastSyncedValue, setLastSyncedValue] = useState<string>(() => JSON.stringify(value));

  useEffect(() => {
    const currentValueStr = JSON.stringify(value);
    if (currentValueStr !== lastSyncedValue) {
      setItems(parseValue(value));
      setLastSyncedValue(currentValueStr);
    }
  }, [value, lastSyncedValue]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setItems(prev => {
        const oldIndex = prev.findIndex(i => i.id === active.id);
        const newIndex = prev.findIndex(i => i.id === over.id);
        const newItems = arrayMove(prev, oldIndex, newIndex);
        const newValue = newItems.map(item => item.provider && item.model ? `${item.provider}/${item.model}` : item.model);
        onChange(newValue);
        setLastSyncedValue(JSON.stringify(newValue));
        return newItems;
      });
    }
  }, [onChange]);

  const handleUpdate = useCallback((id: string, updatedItem: FallbackModel) => {
    setItems(prev => {
      const newItems = prev.map(i => i.id === id ? updatedItem : i);
      const newValue = newItems.map(i => i.provider && i.model ? `${i.provider}/${i.model}` : i.model);
      onChange(newValue);
      setLastSyncedValue(JSON.stringify(newValue));
      return newItems;
    });
  }, [onChange]);

  const handleRemove = useCallback((id: string) => {
    setItems(prev => {
      const newItems = prev.filter(i => i.id !== id);
      const newValue = newItems.map(i => i.provider && i.model ? `${i.provider}/${i.model}` : i.model);
      onChange(newValue);
      setLastSyncedValue(JSON.stringify(newValue));
      return newItems;
    });
  }, [onChange]);

  const handleAdd = useCallback(() => {
    setItems(prev => {
      const newItems = [...prev, { id: generateId(), provider: '', model: '' }];
      const newValue = newItems.map(i => i.provider && i.model ? `${i.provider}/${i.model}` : i.model);
      onChange(newValue);
      setLastSyncedValue(JSON.stringify(newValue));
      return newItems;
    });
  }, [onChange]);

  return (
    <div className="space-y-3">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
          {items.map((item) => (
            <SortableItem
              key={item.id}
              item={item}
              onUpdate={handleUpdate}
              onRemove={handleRemove}
              configuredProviders={configuredProviders}
              extraProviders={extraProviders}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={handleAdd}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-transparent px-4 py-2.5 text-sm text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200"
      >
        <Plus size={16} />
        {t('settings.models.addFallbackModel')}
      </button>
    </div>
  );
}
