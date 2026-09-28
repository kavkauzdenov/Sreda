"use client";

import type {
  ProductEditorState,
  ProductOptionGroup,
  ProductVariantDraft,
} from "@/components/orders-v2/types";

const ATTR_TEMPLATES: Array<{ name: string; options: string[] }> = [
  { name: "Размер", options: ["XS", "S", "M", "L", "XL"] },
  { name: "Цвет", options: ["Чёрный", "Белый", "Бежевый"] },
  { name: "Объём", options: ["250 мл", "500 мл", "1 л"] },
];

function newId() {
  return crypto.randomUUID();
}

function comboKey(optionIds: string[]) {
  return [...optionIds].sort().join("\0");
}

function cartesianOptions(
  groups: ProductOptionGroup[],
): { id: string; name: string }[][] {
  const lists = groups
    .map((g) => g.options.filter((o) => o.name.trim()))
    .filter((opts) => opts.length > 0);
  if (!lists.length) return [];
  return lists.reduce<{ id: string; name: string }[][]>(
    (acc, opts) => acc.flatMap((prefix) => opts.map((o) => [...prefix, o])),
    [[]],
  );
}

export function buildVariantsFromGroups(
  groups: ProductOptionGroup[],
  previous: ProductVariantDraft[],
): ProductVariantDraft[] {
  const combos = cartesianOptions(groups);
  const prevByKey = new Map(previous.map((v) => [comboKey(v.option_ids), v]));
  return combos.map((opts) => {
    const option_ids = opts.map((o) => o.id);
    const key = comboKey(option_ids);
    const prev = prevByKey.get(key);
    return {
      id: prev?.id,
      option_ids,
      label: opts.map((o) => o.name.trim()).join(" / "),
      price: prev?.price ?? "",
      stock_quantity: prev?.stock_quantity ?? "",
      active: prev?.active ?? true,
    };
  });
}

export function ProductVariantsStep({
  value,
  onChange,
  disabled,
}: {
  value: ProductEditorState;
  onChange: (next: ProductEditorState) => void;
  disabled?: boolean;
}) {
  function sync(nextGroups: ProductOptionGroup[]) {
    onChange({
      ...value,
      groups: nextGroups,
      variants: buildVariantsFromGroups(nextGroups, value.variants),
    });
  }

  function addGroup(template?: { name: string; options: string[] }) {
    const next: ProductOptionGroup = {
      id: newId(),
      name: template?.name ?? "",
      options: (template?.options ?? [""]).map((opt) => ({
        id: newId(),
        name: opt,
      })),
    };
    sync([...value.groups, next]);
  }

  return (
    <fieldset disabled={disabled} className="orders-wizard__step">
      <legend>Варианты</legend>
      <label className="orders-wizard__check">
        <input
          type="checkbox"
          checked={value.useVariants}
          onChange={(e) => {
            const on = e.target.checked;
            onChange({
              ...value,
              useVariants: on,
              variantPricesEnabled: on ? value.variantPricesEnabled : false,
            });
          }}
        />
        Есть варианты (атрибуты)
      </label>
      {value.useVariants ? (
        <>
          <label className="orders-wizard__check">
            <input
              type="checkbox"
              checked={value.variantPricesEnabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  variantPricesEnabled: e.target.checked,
                })
              }
            />
            Разные цены для вариантов
          </label>
          <div className="product-editor__templates">
            <span>Шаблоны:</span>
            {ATTR_TEMPLATES.map((t) => (
              <button
                key={t.name}
                type="button"
                className="button button--outline button--sm"
                onClick={() => addGroup(t)}
              >
                {t.name}
              </button>
            ))}
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => addGroup()}
            >
              + Своя группа
            </button>
          </div>
          {value.groups.map((g) => (
            <div key={g.id} className="product-editor__group">
              <label className="field">
                <span className="field__label">Группа атрибутов</span>
                <input
                  className="field__control"
                  placeholder="Например: Размер"
                  value={g.name}
                  onChange={(e) =>
                    sync(
                      value.groups.map((row) =>
                        row.id === g.id
                          ? { ...row, name: e.target.value }
                          : row,
                      ),
                    )
                  }
                />
              </label>
              <div className="product-editor__options">
                {g.options.map((o) => (
                  <div key={o.id} className="product-editor__option-row">
                    <input
                      className="field__control"
                      placeholder="Значение"
                      value={o.name}
                      onChange={(e) =>
                        sync(
                          value.groups.map((row) =>
                            row.id === g.id
                              ? {
                                  ...row,
                                  options: row.options.map((opt) =>
                                    opt.id === o.id
                                      ? { ...opt, name: e.target.value }
                                      : opt,
                                  ),
                                }
                              : row,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() =>
                        sync(
                          value.groups.map((row) =>
                            row.id === g.id
                              ? {
                                  ...row,
                                  options: row.options.filter(
                                    (opt) => opt.id !== o.id,
                                  ),
                                }
                              : row,
                          ),
                        )
                      }
                    >
                      Удалить
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="button button--outline button--sm"
                  onClick={() =>
                    sync(
                      value.groups.map((row) =>
                        row.id === g.id
                          ? {
                              ...row,
                              options: [
                                ...row.options,
                                { id: newId(), name: "" },
                              ],
                            }
                          : row,
                      ),
                    )
                  }
                >
                  + Значение
                </button>
              </div>
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() =>
                  sync(value.groups.filter((row) => row.id !== g.id))
                }
              >
                Удалить группу
              </button>
            </div>
          ))}
          {value.variants.length ? (
            <div className="product-editor__variants">
              <h3>Комбинации ({value.variants.length})</h3>
              <ul className="crm-list">
                {value.variants.map((v, index) => (
                  <li key={comboKey(v.option_ids) || String(index)}>
                    <strong>{v.label || "Вариант"}</strong>
                    {value.variantPricesEnabled ? (
                      <label className="field">
                        <span className="field__label">Цена</span>
                        <input
                          className="field__control"
                          inputMode="decimal"
                          placeholder={value.price || "Базовая"}
                          value={v.price}
                          onChange={(e) =>
                            onChange({
                              ...value,
                              variants: value.variants.map((row, i) =>
                                i === index
                                  ? { ...row, price: e.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : (
                      <span className="account-footnote">Цена: базовая</span>
                    )}
                    <label className="orders-wizard__check">
                      <input
                        type="checkbox"
                        checked={v.active}
                        onChange={(e) =>
                          onChange({
                            ...value,
                            variants: value.variants.map((row, i) =>
                              i === index
                                ? { ...row, active: e.target.checked }
                                : row,
                            ),
                          })
                        }
                      />
                      Активен
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="account-footnote">
              Добавьте группы и значения — комбинации появятся автоматически.
            </p>
          )}
        </>
      ) : null}
    </fieldset>
  );
}
