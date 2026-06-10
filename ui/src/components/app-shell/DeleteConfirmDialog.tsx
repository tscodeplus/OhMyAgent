import { useTranslation } from 'react-i18next';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

interface DeleteConfirmDialogProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DeleteConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation('common');

  return (
    <Modal open={true} onClose={onCancel} title={title} size="sm">
      <p className="text-sm text-neutral-900 dark:text-neutral-100 mb-2">{message}</p>
      <div className="flex justify-end gap-3 mt-4">
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          {t('common.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
