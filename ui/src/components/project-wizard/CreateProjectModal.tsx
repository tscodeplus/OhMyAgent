import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../utils/api';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Textarea from '../ui/Textarea';
import Select from '../ui/Select';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import type { Agent } from '../../types/agent';
import type { Project } from '../../types/project';

interface CreateProjectModalProps {
  onClose: () => void;
  onCreated: (project: Project) => void;
}

export default function CreateProjectModal({ onClose, onCreated }: CreateProjectModalProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [nameError, setNameError] = useState('');

  useEffect(() => {
    apiRequest<Agent[]>('/api/agents')
      .then(setAgents)
      .catch(() => showToast(t('project.loadAgentError'), 'error'));
  }, [showToast]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        setNameError(t('project.nameRequired'));
        return;
      }
      if (name.trim().length > 50) {
        setNameError(t('project.nameTooLong'));
        return;
      }
      if (!selectedAgentId) {
        showToast(t('project.selectAgentRequired'), 'error');
        return;
      }

      setCreating(true);
      try {
        const project = await apiRequest<Project>('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || undefined,
            agent_id: selectedAgentId,
          }),
        });
        showToast(t('project.created'), 'success');
        onCreated(project);
      } catch {
        showToast(t('project.createError'), 'error');
      } finally {
        setCreating(false);
      }
    },
    [name, description, selectedAgentId, showToast, onCreated]
  );

  const agentOptions = agents.map((a) => ({
    value: a.id,
    label: `${a.name} (${a.id})`,
  }));

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={t('project.create')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('project.cancel')}
          </Button>
          <Button onClick={handleSubmit} loading={creating}>
            {t('project.createButton')}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label={t('project.name')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameError('');
          }}
          placeholder={t('project.namePlaceholder')}
          error={nameError || undefined}
          maxLength={50}
          autoFocus
        />
        <Select
          label={t('project.selectAgent')}
          value={selectedAgentId}
          onChange={(e) => setSelectedAgentId(e.target.value)}
          options={[
            { value: '', label: t('project.selectAgentPlaceholder'), disabled: true },
            ...agentOptions,
          ]}
        />
        <Textarea
          label={t('project.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('project.descriptionPlaceholder')}
          rows={3}
        />
      </form>
    </Modal>
  );
}
