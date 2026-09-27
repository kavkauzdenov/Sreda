"use client";

import {
  AttachmentPicker,
  type FileItem,
} from "@/components/attachments/AttachmentPicker";
import type { ProductEditorState } from "@/components/orders-v2/types";

export function ProductImagesStep({
  businessId,
  value,
  onChange,
  disabled,
  uploadNote,
  onUploadNote,
}: {
  businessId: string;
  value: ProductEditorState;
  onChange: (next: ProductEditorState) => void;
  disabled?: boolean;
  uploadNote?: string;
  onUploadNote?: (note: string) => void;
}) {
  return (
    <fieldset disabled={disabled} className="orders-wizard__step">
      <legend>Фото</legend>
      <AttachmentPicker
        businessId={businessId}
        files={value.images as FileItem[]}
        mediaOnly
        disabled={disabled}
        onChange={(files) => {
          const onlyImages = files.filter(
            (f) => f.type === "image" || f.type.startsWith("image"),
          );
          onChange({ ...value, images: onlyImages });
          if (files.length > onlyImages.length) {
            onUploadNote?.("Для товара принимаются только изображения.");
          }
        }}
      />
      <p className="account-footnote">
        Загрузка требует право messages.write. Если файл не загрузился —
        проверьте права доступа.
      </p>
      {uploadNote ? (
        <p role="status" className="account-footnote">
          {uploadNote}
        </p>
      ) : null}
    </fieldset>
  );
}
