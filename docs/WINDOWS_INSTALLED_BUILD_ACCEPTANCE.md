# Windows Installed Build Acceptance

> دليل القبول المؤتمت واليدوي لنسخة RetailOS المثبتة على Windows عبر NSIS.

## التشغيل المؤتمت

```bash
# من جذر المشروع
pnpm --filter @retailos/desktop run test:installed-acceptance

# أو مع تخطي البناء (يتطلب وجود release/win-unpacked/)
pnpm --filter @retailos/desktop run test:installed-acceptance -- --skip-build

# أو مع تحديد مسار exe مباشرة
pnpm --filter @retailos/desktop run test:installed-acceptance -- --exe "C:\path\to\RetailOS.exe"
```

## حماية بيانات الإنتاج

- السكربت يرفض البدء إذا وُجدت أي عملية `RetailOS.exe` تعمل حاليًا.
- يستخدم sandbox معزول تحت `%TEMP%` بدل `%APPDATA%\RetailOS`.
- ينظف جميع العمليات المولّدة عبر شجرة PID قبل حذف المجلد.

## قائمة فحوصات القبول المؤتمتة (10 خطوات)

| # | الفحص | الوصف |
|---|-------|-------|
| 1 | ملفات التثبيت | التحقق من وجود `RetailOS.exe` و`app.asar` و`integrity-manifest.json` |
| 2 | الإقلاع المعزول | تشغيل الخادم المدمج بـ `RETAILOS_DATA_DIR` معزول والاستجابة خلال 30 ثانية |
| 3 | الإعداد الأولي | إنشاء حساب المالك مع عبارة مرور نسخ احتياطي مخصصة |
| 4 | تسجيل الدخول | دخول المالك والتحقق من هوية الجلسة |
| 5 | عزل الـ Sandbox | التحقق من إنشاء SQLite والنسخ الاحتياطية داخل sandbox فقط |
| 6 | عدم وجود مفاتيح نص عادي | التحقق من عدم وجود ملفات `.key` في sandbox |
| 7 | النسخ الاحتياطي اليومي | التحقق من عمل endpoint النسخ الاحتياطي المشفر |
| 8 | حالة الترخيص | التحقق من أن النظام يبدأ بحالة `UNLICENSED` |
| 9 | تنظيف العمليات | التحقق من عدم بقاء عمليات يتيمة بعد الإيقاف |
| 10 | تنظيف Sandbox | حذف مجلد الاختبار المؤقت بالكامل |

## فحوصات يدوية مطلوبة على جهاز Windows فعلي

هذه الفحوصات لا يمكن أتمتتها بالكامل وتتطلب تنفيذًا يدويًا:

### 1. استمرارية DPAPI بعد إعادة تشغيل Windows

1. شغّل الاختبار المؤتمت وسجّل القيم في `daily-backup.bin` و`license-watermark.bin`.
2. أعد تشغيل Windows.
3. شغّل RetailOS وتحقق من أن المفاتيح تُقرأ بنجاح (لا يظهر خطأ DPAPI).
4. تحقق من أن الترخيص لا يزال يعمل والنسخ الاحتياطية المشفرة قابلة للفك.

### 2. عزل حسابات Windows المتعددة

1. أنشئ حساب Windows ثاني.
2. ثبّت RetailOS تحت الحساب الأول.
3. سجّل الدخول بالحساب الثاني وشغّل RetailOS.
4. تحقق من أن `%APPDATA%\RetailOS` لكل حساب مستقل تمامًا.
5. تحقق من أن DPAPI لحساب واحد لا يمكنه فك تشفير بيانات الآخر.

### 3. SmartScreen وتوقيع الكود

1. انقل الـ installer إلى جهاز لم يُشغّل عليه من قبل.
2. شغّل الـ installer وسجّل سلوك Windows SmartScreen.
3. بعد إضافة توقيع كود (Code Signing Certificate): أعد الاختبار وتحقق من عدم ظهور تحذير.

### 4. التثبيت الصامت وإلغاء التثبيت

```powershell
# تثبيت صامت في مجلد مؤقت
.\RetailOS-Setup-0.1.0-x64.exe /S /D=C:\Temp\RetailOS-Test

# تحقق من الملفات
dir "C:\Temp\RetailOS-Test\RetailOS.exe"
dir "C:\Temp\RetailOS-Test\Uninstall RetailOS.exe"

# إلغاء التثبيت الصامت
"C:\Temp\RetailOS-Test\Uninstall RetailOS.exe" /S

# تحقق: الملفات التنفيذية حُذفت لكن %APPDATA%\RetailOS محفوظ
dir "%APPDATA%\RetailOS\retailos.sqlite"
```

## ملاحظات مهمة

- **لا تشغّل هذا الاختبار أثناء تشغيل نسخة إنتاج** — السكربت يحمي من ذلك تلقائيًا.
- **الاختبار المؤتمت لا يختبر NSIS مباشرة** — يختبر الملف التنفيذي من `win-unpacked/` مع sandbox معزول.
- **اختبار NSIS الكامل** (تثبيت/ترقية/إلغاء) يتطلب تنفيذًا يدويًا بصلاحيات مسؤول.
