package netdisc

import "strings"

// ouiTable maps OUI (upper 24 bits of MAC) to vendor — curated subset.
var ouiTable = map[string]string{
	"001A2B": "Apple",
	"3C0754": "Apple",
	"AC1F6B": "Apple",
	"DC2B2A": "Apple",
	"E0F847": "Apple",
	"001E52": "Apple",
	"000C29": "VMware",
	"005056": "VMware",
	"080027": "Oracle VirtualBox",
	"525400": "QEMU/KVM",
	"00163E": "Xen",
	"0017FA": "Microsoft",
	"7C1E52": "Microsoft",
	"DC9C52": "Sagemcom",
	"D85D4C": "TP-LINK",
	"60E327": "Belkin",
	"00146C": "NETGEAR",
	"485B39": "ASUS",
	"04D9F5": "ASUS",
	"7C2EBD": "Synology",
	"001132": "Synology",
	"3CD92B": "Hewlett-Packard",
	"D89EF3": "Hewlett-Packard",
	"4C8D79": "Ubiquiti",
	"FCECDA": "Ubiquiti",
	"E063DA": "Ubiquiti",
	"68D79A": "Cisco",
	"B0AA77": "Cisco",
	"00408C": "Axis Communications",
	"AC3613": "Hikvision",
	"BC51FE": "Hikvision",
	"D44B5E": "TP-Link",
	"B827EB": "Raspberry Pi",
	"DCA632": "Raspberry Pi",
	"E45F01": "Raspberry Pi",
	"00501F": "Realtek",
	"002711": "Realtek",
	"4CCC6A": "Murata Manufacturing",
	"0050C2": "IEEE Registration Authority",
	"0023AC": "Brother",
	"6037BD": "Brocade",
	"00073F": "Honda",
	"D094BA": "Aruba",
	"E099CD": "Apple Watch",
	"40A36B": "HP Inc.",
	"24A074": "Apple",
	"784F43": "Apple",
	"94BF2D": "ESPRESSIF",
	"AC67B2": "ESPRESSIF",
	"246F28": "ESPRESSIF",
	"7CDFA1": "ESPRESSIF",
	"08BFB8": "ASUSTek",
	"FCAA14": "Giga-Byte",
	"6C3BE5": "Hewlett-Packard",
	"3CD7DA": "ASRock",
	"00248C": "ASUSTek",
	"40167E": "ASUSTek",
}

// LookupVendor returns the vendor name for the given MAC, or "" if
// unknown. Accepts MACs in colon-, dash-, or undelimited form, lower
// or upper case.
func LookupVendor(mac string) string {
	if mac == "" {
		return ""
	}
	norm := strings.ToUpper(mac)
	norm = strings.ReplaceAll(norm, ":", "")
	norm = strings.ReplaceAll(norm, "-", "")
	norm = strings.ReplaceAll(norm, ".", "")
	if len(norm) < 6 {
		return ""
	}
	prefix := norm[:6]
	if v, ok := ouiTable[prefix]; ok {
		return v
	}
	return ""
}
