import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useState } from "react";

type ToggleSetting = {
    stateKey: "sslForced" | "hstsSubdomains" | "skipHttpsHostnameValidation";
    fieldName: "sslForced" | "hstsSubdomains" | "skipHttpsHostnameValidation";
    label: string;
    description: string;
};

type SettingsTogglesProps = {
    sslForced?: boolean;
    hstsSubdomains?: boolean;
    skipHttpsValidation?: boolean;
    enabled?: boolean;
};

export function SettingsToggles({
    sslForced = true,
    hstsSubdomains = true,
    skipHttpsValidation = false,
    enabled = true
}: SettingsTogglesProps) {
    const [values, setValues] = useState({
        sslForced: sslForced,
        hstsSubdomains: hstsSubdomains,
        skipHttpsHostnameValidation: skipHttpsValidation,
        enabled: enabled
    });

    const handleChange = (name: keyof typeof values) => (checked: boolean) => {
        setValues(prev => ({ ...prev, [name]: checked }));
    };

    const settings: ToggleSetting[] = [
        {
            stateKey: "sslForced",
            fieldName: "sslForced",
            label: "Force SSL",
            description: "Redirect HTTP requests to HTTPS",
        },
        {
            stateKey: "hstsSubdomains",
            fieldName: "hstsSubdomains",
            label: "HSTS Subdomains",
            description: "Include subdomains in the Strict-Transport-Security header",
        },
        {
            stateKey: "skipHttpsHostnameValidation",
            fieldName: "skipHttpsHostnameValidation",
            label: "Skip HTTPS Validation",
            description: "Skip SSL certificate hostname verification for backend connections",
        }
    ];

    return (
        <div className="flex flex-col gap-6">
            <input type="hidden" name="enabledPresent" value="1" />
            <input type="hidden" name="enabled" value={values.enabled ? "on" : ""} />

            {/* Main Enable Switch */}
            <div className={cn(
                "flex flex-row items-center justify-between p-4 rounded-lg border transition-all duration-200",
                values.enabled
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background"
            )}>
                <div>
                    <p className={cn("text-sm font-semibold", values.enabled ? "text-primary" : "text-foreground")}>
                        {values.enabled ? "Proxy Host Enabled" : "Proxy Host Paused"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                        {values.enabled
                            ? "This host is active and routing traffic"
                            : "This host is disabled and will not respond to requests"}
                    </p>
                </div>
                <Switch
                    checked={values.enabled}
                    onCheckedChange={handleChange("enabled")}
                />
            </div>

            {/* Advanced Options */}
            <div className="rounded-lg border border-border bg-background overflow-hidden">
                <div className="px-4 py-3 border-b border-border bg-white/5 dark:bg-white/2">
                    <p className="text-sm font-semibold">Advanced Options</p>
                </div>
                <div className="divide-y divide-border">
                    {settings.map((setting) => (
                        <div key={setting.stateKey}>
                            <input type="hidden" name={`${setting.fieldName}Present`} value="1" />
                            <div className="flex flex-row items-center justify-between px-4 py-3">
                                <div className="pr-4">
                                    <p className="text-sm font-medium">{setting.label}</p>
                                    <span className="text-xs text-muted-foreground">{setting.description}</span>
                                </div>
                                <Switch
                                    name={setting.fieldName}
                                    checked={values[setting.stateKey]}
                                    onCheckedChange={handleChange(setting.stateKey)}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
