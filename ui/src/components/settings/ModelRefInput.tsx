import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ModelPicker from './ModelPicker';
import type { ProviderOption } from './ModelPicker';

interface ModelRefInputProps {
  value: string;
  onChange: (modelRef: string) => void;
  label?: string;
  placeholder?: string;
  extraProviders?: ProviderOption[];
  showMetaBadges?: boolean;
  configuredProviders?: string[];
  className?: string;
}

export default function ModelRefInput({
  value,
  onChange,
  label,
  placeholder,
  extraProviders,
  showMetaBadges = false,
  configuredProviders,
  className,
}: ModelRefInputProps) {
  const { t } = useTranslation('common');

  const { provider, model } = useMemo(() => {
    const slashIdx = value.indexOf('/');
    if (slashIdx > 0) {
      return { provider: value.slice(0, slashIdx), model: value.slice(slashIdx + 1) };
    }
    return { provider: '', model: value };
  }, [value]);

  const handleChangeProvider = (newProvider: string) => {
    if (model) {
      onChange(`${newProvider}/${model}`);
    } else {
      onChange(newProvider);
    }
  };

  const handleChangeModel = (newModel: string) => {
    if (provider) {
      onChange(`${provider}/${newModel}`);
    } else {
      onChange(newModel);
    }
  };

  return (
    <ModelPicker
      provider={provider}
      model={model}
      onChangeProvider={handleChangeProvider}
      onChangeModel={handleChangeModel}
      providerLabel={label ? `${label} — ${t('settings.models.provider')}` : undefined}
      modelLabel={label ? `${label} — ${t('settings.models.model')}` : undefined}
      modelPlaceholder={placeholder}
      extraProviders={extraProviders}
      showMetaBadges={showMetaBadges}
      showTestButton={false}
      configuredProviders={configuredProviders}
      className={className}
    />
  );
}
