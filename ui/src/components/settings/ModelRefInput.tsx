import { useMemo } from 'react';
import ModelPicker from './ModelPicker';
import type { ProviderOption } from './ModelPicker';

interface ModelRefInputProps {
  value: string;
  onChange: (modelRef: string) => void;
  label?: string;
  placeholder?: string;
  extraProviders?: ProviderOption[];
  showMetaBadges?: boolean;
  className?: string;
}

export default function ModelRefInput({
  value,
  onChange,
  label,
  placeholder,
  extraProviders,
  showMetaBadges = false,
  className,
}: ModelRefInputProps) {
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
      providerLabel={label ? `${label} — Provider` : undefined}
      modelLabel={label ? `${label} — Model` : undefined}
      modelPlaceholder={placeholder}
      extraProviders={extraProviders}
      showMetaBadges={showMetaBadges}
      showTestButton={false}
      className={className}
    />
  );
}
