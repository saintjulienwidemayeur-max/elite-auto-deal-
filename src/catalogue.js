// Définitions des services et données initiales (miroir du site public)
export const SERVICES = {
  precommande: { titre: "Précommande d'un véhicule", vehicule: "precommandable",
    statuts: ["Paiement initial (90 %) confirmé", "Véhicule en préparation à l'expédition", "En transit vers Haïti", "Arrivé en Haïti, solde de 10 % à régler", "Livré"] },
  achat: { titre: "Achat comptant d'un véhicule", vehicule: "disponible",
    statuts: ["Paiement confirmé", "Préparation du véhicule et des documents", "Livraison planifiée", "Livré"] },
  consultation: { titre: "Consultation automobile", tarif: "consultation",
    statuts: ["Paiement confirmé", "Prise de contact sur WhatsApp", "Consultation planifiée", "Consultation effectuée"] },
  recherche: { titre: "Recherche personnalisée ou achat accompagné", tarif: "recherche",
    statuts: ["Paiement confirmé", "Prise de contact sur WhatsApp", "Recherche en cours", "Proposition de véhicule", "Dossier clôturé"] },
  essai: { titre: "Réservation d'une visite ou d'un essai", tarif: "essai", vehicule: "optionnel",
    statuts: ["Paiement confirmé", "Disponibilité du véhicule vérifiée", "Rendez-vous confirmé", "Visite ou essai effectué"] },
  vendre: { titre: "Service de vente d'un véhicule", tarif: "vendre",
    statuts: ["Dossier reçu et payé", "Vérification du véhicule et des documents", "Accepté, annonce en préparation", "Annonce publiée", "Vendu"] },
  financement: { titre: "Dossier de financement", tarif: "financement",
    statuts: ["Demande reçue", "Vérification des documents", "Dossier en cours d'examen", "Décision finale de financement"] },
};

export const PARAMETRES_DEFAUT = {
  taux: { taux_htg: 132, taux_date: "2026-11-12" },
  tarifs: { consultation: 50, recherche: 50, essai: 30, vendre: 200, financement: 25 },
  messages: {
    accueil: "🚘 ELITE AUTO DEAL vous souhaite la bienvenue !\n\nMerci de votre intérêt et de votre confiance.\n\nAfin de mieux répondre à votre demande, veuillez nous communiquer les informations suivantes :\n\nMarque :\nAnnée :\nModèle :\nBudget :\nMode de paiement : Comptant ou financement ?\nType de demande : Achat, précommande, recherche personnalisée ou réservation d'un essai ?\n\nNotre plateforme vous permet de consulter nos véhicules, de soumettre votre demande et d'effectuer les paiements de nos services en ligne de manière sécurisée.\n\nUne fois votre demande enregistrée et le paiement confirmé, vous recevrez les informations nécessaires pour la suite.\n\nELITE AUTO DEAL, Votre satisfaction, notre priorité ! 🤝",
    confirmation: "Bonjour {prenom}, votre paiement pour « {service} » est confirmé. Référence : {ref}. Suivi : {lien_suivi}",
    solde: "Bonjour {prenom}, votre {vehicule} est arrivé en Haïti. Le solde de 10 % ({montant}) peut être réglé ici : {lien}. Référence : {ref}.",
    rappel: "Bonjour {prenom}, petit rappel : le paiement du dossier {ref} est toujours en attente. Lien : {lien}",
  },
};

// Inventaire publié sur Instagram (à confirmer par Elite Auto Deal)
export const VEHICULES_INITIAUX = [
  ["gle17","Mercedes-Benz","GLE 2017",2017,"Rouge","#8E1419",75000,26500,"disponible","SUV","suv","V6","Automatique","4x4",5,null,"Financement disponible",true],
  ["cay16","Porsche","Cayenne 2016",2016,"Gris","#6F7379",73000,28000,"precommande","SUV","suv","V6","Automatique","4x4",5,"5 à 8 semaines",null,true],
  ["fro21","Nissan","Frontier LE 2021",2021,"Rouge","#A3141A",90000,43500,"transit","Pick-up","pickup","V6","Automatique","4x4",5,"2 à 3 semaines","Prix ferme",true],
  ["rav16","Toyota","RAV4 2016",2016,"Noir","#202226",33000,22500,"precommande","SUV","suv","4 cylindres","Automatique","Traction avant",5,"4 à 6 semaines",null,true],
  ["jgc21","Jeep","Grand Cherokee Laredo 2021",2021,"Gris","#7D8187",78000,24000,"disponible","SUV","suv","V6","Automatique","4x4",5,null,null,false],
  ["vit19","Suzuki","Vitara 2019",2019,"Blanc","#E9EAEC",77000,18000,"disponible","SUV","suv","4 cylindres","Automatique","Traction avant",5,null,"Payable en deux versements",false],
  ["for14","Subaru","Forester 2014",2014,"Rouge","#7E1620",82000,15000,"precommande","SUV","suv","4 cylindres","Automatique","4x4",5,"4 à 6 semaines",null,false],
  ["spo12","Kia","Sportage 2012",2012,"Noir","#1F2023",71000,13500,"disponible","SUV","suv","4 cylindres","Automatique","Traction avant",5,null,null,false],
  ["san15","Hyundai","Santa Fe Sport 2015",2015,"Blanc","#ECEDEF",60000,12000,"disponible","SUV","suv","4 cylindres","Automatique","Traction avant",5,null,null,false],
  ["spo24","Kia","Sportage 2024",2024,"Noir","#18191C",null,30000,"precommande","SUV","suv","4 cylindres","Automatique","Traction avant",5,"6 à 8 semaines",null,false],
  ["for18","Subaru","Forester 2018",2018,"Rouge","#8A1820",null,20500,"transit","SUV","suv","4 cylindres","Automatique","4x4",5,"2 à 3 semaines",null,false],
  ["sor15","Kia","Sorento 2015",2015,"Noir","#1C1D20",null,14000,"precommande","SUV","suv","V6","Automatique","Traction avant",7,"4 à 6 semaines","Prix tout compris : transport et dédouanement inclus",false],
  ["4ru","Toyota","4Runner",2019,"Blanc","#E6E7EA",66000,null,"disponible","4x4","suv","V6 4.0L","Automatique","4x4",7,null,null,false],
  ["wra","Jeep","Wrangler Unlimited",2014,"Noir","#1A1B1E",195000,null,"disponible","4x4","suv","V6","Automatique","4x4",5,null,null,false],
  ["jgc15","Jeep","Grand Cherokee 2015",2015,"Rouge","#8C1A1F",75000,21500,"vendu","SUV","suv","V6","Automatique","4x4",5,null,null,false],
];
export const COLS_VEHICULE = ["id","marque","modele","annee","couleur","hex","km","prix","statut","type","forme","moteur","trans","traction","places","delai","note","vedette"];
