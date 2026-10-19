import { describe, expect, it } from "vitest";
import { foreignDescriptionLanguage } from "./description-language.ts";
import { classifyLocation } from "./location.ts";

const SPANISH =
  "Buscamos una persona con experiencia en React para unirse a nuestro equipo. Trabajará con los equipos de producto y diseño para construir las nuevas funciones de la plataforma. Ofrecemos un ambiente colaborativo y las prestaciones de ley. Enviar el currículum por correo electrónico a la dirección de esta publicación.";
const ENGLISH =
  "We are looking for a person with experience in React to join our team. You will work with the product and design teams to build the new features of the platform. We offer a collaborative environment and generous benefits.";

describe("foreignDescriptionLanguage", () => {
  it("names a Spanish description", () => {
    expect(foreignDescriptionLanguage(SPANISH)).toBe("spanish");
  });

  it("is null for English, empty and short text", () => {
    expect(foreignDescriptionLanguage(ENGLISH)).toBeNull();
    expect(foreignDescriptionLanguage("")).toBeNull();
    expect(foreignDescriptionLanguage(null)).toBeNull();
    expect(
      foreignDescriptionLanguage("Buscamos desarrollador con experiencia en React."),
    ).toBeNull();
  });

  it("is null when English makes up a large part of the text", () => {
    expect(foreignDescriptionLanguage(`${ENGLISH} ${SPANISH}`)).toBeNull();
  });
});

describe("hybrid and on-site wording in Spanish and Portuguese", () => {
  const place = "Example City, Exampleland";
  it.each([
    "Modalidad de trabajo híbrida",
    "Puesto híbrido, tres días en la oficina",
    "Trabajo presencial de lunes a viernes",
    "Trabalho presencial no escritório",
    "Regime híbrido",
  ])("settles %s as restricted", (descriptionText) => {
    expect(classifyLocation({ locationText: place, descriptionText }).class).toBe("restricted");
  });

  it("does not settle a posting that also offers remote work", () => {
    expect(
      classifyLocation({
        locationText: place,
        descriptionText: "Modalidad híbrida o trabajo remoto según el equipo",
      }).class,
    ).toBe("unclear");
  });

  it("does not use it when the source marks the posting remote", () => {
    expect(
      classifyLocation({ locationText: place, descriptionText: "Modalidad híbrida", remote: true })
        .class,
    ).toBe("unclear");
  });
});
